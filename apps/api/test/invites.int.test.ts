import type { TokenResponse } from '@dhc/contracts';
import { CreatedStaffInvite, InviteDetails, StaffInviteList } from '@dhc/contracts';
import { withTenant } from '@dhc/db';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashPassword } from '../src/auth/password';
import type * as PasswordModule from '../src/auth/password';
import { totpAt } from '../src/auth/totp';

/** Runs, when set, at the start of every password check or hash. */
const passwordCheck = vi.hoisted(() => ({ hook: undefined as (() => Promise<void>) | undefined }));
vi.mock('../src/auth/password', async (importOriginal) => {
  const actual = await importOriginal<typeof PasswordModule>();
  return {
    ...actual,
    verifyPassword: async (password: string, stored: string) => {
      await passwordCheck.hook?.();
      return actual.verifyPassword(password, stored);
    },
    hashPassword: async (password: string) => {
      await passwordCheck.hook?.();
      return actual.hashPassword(password);
    },
  };
});
import {
  STAFF_PASSWORD,
  bearer,
  createHarness,
  resetDatabase,
  seedTwoClinics,
  staffLogin,
} from './harness';

const h = createHarness();
let clinics: Awaited<ReturnType<typeof seedTwoClinics>>;
let adminA: TokenResponse;

beforeEach(async () => {
  await resetDatabase(h.owner);
  clinics = await seedTwoClinics(h);
  adminA = await staffLogin(h, 'clinic-a', clinics.a.admin);
});

afterAll(async () => {
  await h.app.close();
  await h.owner.$disconnect();
});

const NEW_PASSWORD = 'a long synthetic passphrase';
const post = (url: string, payload?: unknown, headers?: Record<string, string>) =>
  h.app.inject({ method: 'POST', url: `/v1${url}`, payload: payload as object, headers });

async function invite(
  tokens: TokenResponse,
  body: { identifier: string; role: string; displayName?: string } = {
    identifier: 'new.doctor@clinic-a.test',
    role: 'doctor',
    displayName: 'New Doctor',
  },
) {
  const res = await post('/staff/invites', body, bearer(tokens));
  expect(res.statusCode, res.body).toBe(201);
  const created = CreatedStaffInvite.parse(res.json());
  return { created, token: new URL(created.inviteUrl).hash.slice(1) };
}

/** Accept with a new password, then complete with the authenticator's first code. */
async function setUpAccount(token: string) {
  const accept = await post('/auth/invites/accept', { token, password: NEW_PASSWORD });
  expect(accept.statusCode, accept.body).toBe(200);
  const secret = new URL(accept.json().otpauthUri).searchParams.get('secret')!;
  h.clock.advance(30);
  const complete = await post('/auth/invites/complete', {
    token,
    code: totpAt(secret, h.clock.ms / 1000),
  });
  return { complete, secret };
}

describe('clinic admin', () => {
  it('creates a single-use link that carries the token only in the URL fragment', async () => {
    const { created, token } = await invite(adminA);
    expect(created).toMatchObject({
      role: 'doctor',
      status: 'pending',
      identifier: 'new.doctor@clinic-a.test',
    });
    expect(new URL(created.inviteUrl).pathname).toBe('/invite');
    expect(token.length).toBeGreaterThanOrEqual(40);

    const stored = await h.owner.staffInvite.findFirstOrThrow();
    expect(stored.tokenHash).not.toContain(token);
    const membership = await h.owner.membership.findFirstOrThrow({
      where: { userId: stored.userId },
    });
    expect(membership.status).toBe('invited');
  });

  it('lists invites with their status', async () => {
    const { created } = await invite(adminA);
    const res = await h.app.inject({
      method: 'GET',
      url: '/v1/staff/invites',
      headers: bearer(adminA),
    });
    expect(StaffInviteList.parse(res.json()).data).toEqual([
      expect.objectContaining({ id: created.id, status: 'pending' }),
    ]);
  });

  it('is limited to clinic admins', async () => {
    const doctor = await staffLogin(h, 'clinic-a', clinics.a.doctor);
    const res = await post(
      '/staff/invites',
      { identifier: 'x@clinic-a.test', role: 'doctor' },
      bearer(doctor),
    );
    expect(res.statusCode).toBe(403);
  });

  it('rejects inviting someone who already has the role', async () => {
    const res = await post(
      '/staff/invites',
      { identifier: clinics.a.doctor.email, role: 'doctor' },
      bearer(adminA),
    );
    expect(res.statusCode).toBe(409);
  });

  it('replaces an earlier open invite for the same person and role', async () => {
    const first = await invite(adminA);
    await invite(adminA);
    expect((await post('/auth/invites/inspect', { token: first.token })).statusCode).toBe(404);
  });

  it('cannot see or revoke another organisation’s invites', async () => {
    const adminB = await staffLogin(h, 'clinic-b', clinics.b.admin);
    const { created } = await invite(adminA);
    const list = await h.app.inject({
      method: 'GET',
      url: '/v1/staff/invites',
      headers: bearer(adminB),
    });
    expect(list.json().data).toEqual([]);
    expect(
      (await post(`/staff/invites/${created.id}/revoke`, undefined, bearer(adminB))).statusCode,
    ).toBe(404);
  });

  it('cannot create an invite in another organisation, even directly in the database', async () => {
    await expect(
      withTenant(h.services.db, clinics.a.org.id, (tx) =>
        tx.staffInvite.create({
          data: {
            organisationId: clinics.b.org.id,
            userId: clinics.a.doctor.userId,
            role: 'clinic_admin',
            tokenHash: 'x',
            createdByUserId: clinics.a.admin.userId,
            expiresAt: new Date(Date.now() + 60_000),
          },
        }),
      ),
    ).rejects.toThrow(/row-level security/);
  });
});

describe('accepting an invite (new account)', () => {
  it('sets a password and authenticator, then signs in', async () => {
    const { token } = await invite(adminA);
    const details = InviteDetails.parse((await post('/auth/invites/inspect', { token })).json());
    expect(details).toMatchObject({
      role: 'doctor',
      account: 'new',
      identifier: 'ne****@clinic-a.test',
      organisation: { slug: 'clinic-a' },
    });

    const { complete, secret } = await setUpAccount(token);
    expect(complete.statusCode, complete.body).toBe(200);
    const me = await h.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: bearer(complete.json()),
    });
    expect(me.json()).toMatchObject({ role: 'doctor', organisation: { slug: 'clinic-a' } });

    // From now on, normal password + authenticator sign-in works.
    const login = await post('/auth/login', {
      organisation: 'clinic-a',
      identifier: 'new.doctor@clinic-a.test',
      password: NEW_PASSWORD,
    });
    expect(login.json().status).toBe('mfa_required');
    h.clock.advance(30);
    const mfa = await post('/auth/mfa/verify', {
      mfaToken: login.json().mfaToken,
      code: totpAt(secret, h.clock.ms / 1000),
    });
    expect(mfa.statusCode).toBe(200);

    const actions = (
      await h.owner.auditLog.findMany({ where: { organisationId: clinics.a.org.id } })
    ).map((a) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'staff.invite.created',
        'staff.invite.accepted',
        'auth.mfa.enrolled',
      ]),
    );
  });

  it('works only once', async () => {
    const { token } = await invite(adminA);
    expect((await setUpAccount(token)).complete.statusCode).toBe(200);
    expect((await post('/auth/invites/inspect', { token })).statusCode).toBe(404);
    expect((await post('/auth/invites/accept', { token, password: NEW_PASSWORD })).statusCode).toBe(
      404,
    );
  });

  it('enforces a minimum password length', async () => {
    const { token } = await invite(adminA);
    const res = await post('/auth/invites/accept', { token, password: 'short' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.fields).toHaveProperty('password');
  });

  it('keeps the invite open after a wrong code', async () => {
    const { token } = await invite(adminA);
    const accept = await post('/auth/invites/accept', { token, password: NEW_PASSWORD });
    const secret = new URL(accept.json().otpauthUri).searchParams.get('secret')!;
    expect((await post('/auth/invites/complete', { token, code: '000000' })).statusCode).toBe(401);
    h.clock.advance(30);
    expect(
      (await post('/auth/invites/complete', { token, code: totpAt(secret, h.clock.ms / 1000) }))
        .statusCode,
    ).toBe(200);
  });

  it('cannot be completed before a password is set', async () => {
    const { token } = await invite(adminA);
    expect((await post('/auth/invites/complete', { token, code: '123456' })).statusCode).toBe(409);
  });

  it('does not let a half-finished setup sign in with the password alone', async () => {
    const { token } = await invite(adminA);
    await post('/auth/invites/accept', { token, password: NEW_PASSWORD });
    const login = await post('/auth/login', {
      organisation: 'clinic-a',
      identifier: 'new.doctor@clinic-a.test',
      password: NEW_PASSWORD,
    });
    expect(login.statusCode).toBe(401);
  });

  it('expires after 72 hours', async () => {
    const { token } = await invite(adminA);
    h.clock.advance(72 * 3600 + 1);
    expect((await post('/auth/invites/inspect', { token })).statusCode).toBe(404);
  });

  it('stops working when revoked', async () => {
    const { created, token } = await invite(adminA);
    expect(
      (await post(`/staff/invites/${created.id}/revoke`, undefined, bearer(adminA))).statusCode,
    ).toBe(204);
    expect((await post('/auth/invites/accept', { token, password: NEW_PASSWORD })).statusCode).toBe(
      404,
    );
    const membership = await h.owner.membership.findFirstOrThrow({
      where: { organisationId: clinics.a.org.id, role: 'doctor', status: { not: 'active' } },
    });
    expect(membership.status).toBe('revoked');
  });

  it('rejects made-up tokens', async () => {
    expect((await post('/auth/invites/inspect', { token: 'x'.repeat(43) })).statusCode).toBe(404);
  });
});

describe('accepting an invite (existing staff account)', () => {
  it('adds the role after confirming the current password and authenticator', async () => {
    // Clinic B's doctor is invited to clinic A as well.
    const doctorB = clinics.b.doctor;
    const { token } = await invite(adminA, { identifier: doctorB.email, role: 'doctor' });
    expect((await post('/auth/invites/inspect', { token })).json().account).toBe('existing');

    expect(
      (await post('/auth/invites/accept', { token, password: 'wrong password!!' })).statusCode,
    ).toBe(401);
    const accept = await post('/auth/invites/accept', { token, password: STAFF_PASSWORD });
    expect(accept.json()).toEqual({ status: 'confirm_required' });

    h.clock.advance(30);
    const complete = await post('/auth/invites/complete', {
      token,
      code: totpAt(doctorB.totpSecret, h.clock.ms / 1000),
    });
    expect(complete.statusCode, complete.body).toBe(200);
    const me = await h.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: bearer(complete.json()),
    });
    expect(me.json().organisation.slug).toBe('clinic-a');

    // The existing password and authenticator were not replaced.
    const user = await h.owner.user.findUniqueOrThrow({ where: { id: doctorB.userId } });
    expect(h.services.cipher.decrypt(user.mfaSecret!)).toBe(doctorB.totpSecret);
  });
});

describe('while the password is checked or hashed', () => {
  afterEach(() => {
    passwordCheck.hook = undefined;
  });

  /** Counts sessions sitting in an open transaction each time the hook runs. */
  const countOpenTransactions = (open: number[]) => async () => {
    const [row] = await h.owner.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND state LIKE 'idle in transaction%'`;
    open.push(row!.n);
  };
  const accept = (token: string, password: string) =>
    post('/auth/invites/accept', { token, password });
  const revokeDuringCheck = (inviteId: string) => async () => {
    const res = await post(`/staff/invites/${inviteId}/revoke`, undefined, bearer(adminA));
    expect(res.statusCode).toBe(204);
  };

  describe('new account', () => {
    const newUser = () =>
      h.owner.user.findUniqueOrThrow({ where: { email: 'new.doctor@clinic-a.test' } });

    // scrypt is slow by design; inside a transaction a busy CPU pushed it past Prisma's
    // 5 s interactive-transaction timeout and accepting failed with a 500.
    it('keeps no transaction open', async () => {
      const { token } = await invite(adminA);
      const open: number[] = [];
      passwordCheck.hook = countOpenTransactions(open);
      expect((await accept(token, NEW_PASSWORD)).statusCode).toBe(200);
      expect(open).toEqual([0]);
    });

    it('sets nothing when the invite is revoked meanwhile', async () => {
      const { created, token } = await invite(adminA);
      passwordCheck.hook = revokeDuringCheck(created.id);
      expect((await accept(token, NEW_PASSWORD)).statusCode).toBe(404);
      const user = await newUser();
      expect(user.passwordHash).toBeNull();
      expect(user.mfaPendingSecret).toBeNull();
    });

    it('still replaces an unfinished password when started again', async () => {
      const { token } = await invite(adminA);
      const first = await accept(token, NEW_PASSWORD);
      expect(first.statusCode).toBe(200);
      const before = await newUser();
      const second = await accept(token, `${NEW_PASSWORD} again`);
      expect(second.statusCode).toBe(200);
      const after = await newUser();
      expect(after.passwordHash).not.toBe(before.passwordHash);
      expect(after.mfaPendingSecret).not.toBe(before.mfaPendingSecret);
      expect(second.json().otpauthUri).not.toBe(first.json().otpauthUri);
    });

    it('never replaces the password of an account that finished enrolling meanwhile', async () => {
      const { token } = await invite(adminA);
      const enrolledHash = await hashPassword('another-Passw0rd!');
      passwordCheck.hook = async () => {
        await h.owner.user.update({
          where: { email: 'new.doctor@clinic-a.test' },
          data: {
            passwordHash: enrolledHash,
            mfaSecret: h.services.cipher.encrypt('JBSWY3DPEHPK3PXP'),
          },
        });
      };
      expect((await accept(token, NEW_PASSWORD)).statusCode).toBe(409);
      const user = await newUser();
      expect(user.passwordHash).toBe(enrolledHash);
      expect(user.mfaPendingSecret).toBeNull();
    });
  });

  describe('existing staff account', () => {
    const doctorB = () => clinics.b.doctor;
    const doctorBRow = () => h.owner.user.findUniqueOrThrow({ where: { id: doctorB().userId } });
    const inviteDoctorB = () => invite(adminA, { identifier: doctorB().email, role: 'doctor' });

    it.each([
      ['the right password', STAFF_PASSWORD, 200],
      ['a wrong password', 'wrong password!!', 401],
    ])('keeps no transaction open (%s)', async (_, password, status) => {
      const { token } = await inviteDoctorB();
      const open: number[] = [];
      passwordCheck.hook = countOpenTransactions(open);
      expect((await accept(token, password)).statusCode).toBe(status);
      expect(open).toEqual([0]);
    });

    it('refuses an invite revoked meanwhile', async () => {
      const { created, token } = await inviteDoctorB();
      passwordCheck.hook = revokeDuringCheck(created.id);
      expect((await accept(token, STAFF_PASSWORD)).statusCode).toBe(404);
    });

    it('refuses a password changed meanwhile and counts it as a failure', async () => {
      const { created, token } = await inviteDoctorB();
      const changed = await hashPassword('another-Passw0rd!');
      passwordCheck.hook = async () => {
        await h.owner.user.update({
          where: { id: doctorB().userId },
          data: { passwordHash: changed },
        });
      };
      expect((await accept(token, STAFF_PASSWORD)).statusCode).toBe(401);
      expect((await doctorBRow()).failedLoginCount).toBe(1);
      expect(
        await h.owner.auditLog.count({
          where: { action: 'staff.invite.password_failed', entityId: created.id },
        }),
      ).toBe(1);
    });

    it('does not count an authenticator reset meanwhile as a wrong password', async () => {
      const { token } = await inviteDoctorB();
      passwordCheck.hook = async () => {
        await h.owner.user.update({
          where: { id: doctorB().userId },
          data: { mfaSecret: null, passwordHash: null },
        });
      };
      expect((await accept(token, STAFF_PASSWORD)).statusCode).toBe(409);
      expect((await doctorBRow()).failedLoginCount).toBe(0);
    });

    it('refuses an account locked meanwhile', async () => {
      const { token } = await inviteDoctorB();
      passwordCheck.hook = async () => {
        await h.owner.user.update({
          where: { id: doctorB().userId },
          data: { lockedUntil: new Date(h.clock.now().getTime() + 60_000) },
        });
      };
      expect((await accept(token, STAFF_PASSWORD)).statusCode).toBe(429);
    });
  });
});
