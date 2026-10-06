import type { TokenResponse } from '@dhc/contracts';
import { CreatedStaffInvite, InviteDetails, StaffInviteList } from '@dhc/contracts';
import { withTenant } from '@dhc/db';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { totpAt } from '../src/auth/totp';
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
