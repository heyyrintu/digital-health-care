import { MeResponse, OtpRequestResponse, TokenResponse } from '@dhc/contracts';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { totpAt } from '../src/auth/totp';
import { hashPassword } from '../src/auth/password';
import type * as PasswordModule from '../src/auth/password';

/** Runs, when set, at the start of every password check. */
const passwordCheck = vi.hoisted(() => ({ hook: undefined as (() => Promise<void>) | undefined }));
vi.mock('../src/auth/password', async (importOriginal) => {
  const actual = await importOriginal<typeof PasswordModule>();
  return {
    ...actual,
    verifyPassword: async (password: string, stored: string) => {
      await passwordCheck.hook?.();
      return actual.verifyPassword(password, stored);
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

beforeEach(async () => {
  await resetDatabase(h.owner);
  h.sentCodes.length = 0;
  clinics = await seedTwoClinics(h);
});

afterAll(async () => {
  await h.app.close();
  await h.owner.$disconnect();
});

const post = (url: string, payload: unknown, headers?: Record<string, string>) =>
  h.app.inject({ method: 'POST', url: `/v1${url}`, payload: payload as object, headers });

const WRONG_CODE = '000000';

describe('patient sign-in with a mobile code', () => {
  const requestCode = async (phone = '98765 43210') => {
    const res = await post('/auth/otp/request', { organisation: 'clinic-a', phone });
    expect(res.statusCode).toBe(200);
    return OtpRequestResponse.parse(res.json());
  };

  it('signs in, creates the patient account and membership, and never stores the code', async () => {
    const { challengeId } = await requestCode();
    const sent = h.sentCodes.at(-1)!;
    expect(sent.phone).toBe('+919876543210');

    const stored = await h.owner.otpChallenge.findUniqueOrThrow({ where: { id: challengeId } });
    expect(stored.codeHash).not.toContain(sent.code);

    const res = await post('/auth/otp/verify', { challengeId, code: sent.code });
    expect(res.statusCode).toBe(200);
    const tokens = TokenResponse.parse(res.json());

    const me = MeResponse.parse(
      (await h.app.inject({ method: 'GET', url: '/v1/me', headers: bearer(tokens) })).json(),
    );
    expect(me).toMatchObject({
      role: 'patient',
      organisation: { slug: 'clinic-a' },
      user: { phone: '+919876543210' },
    });
  });

  it('accepts a code only once', async () => {
    const { challengeId } = await requestCode();
    const { code } = h.sentCodes.at(-1)!;
    expect((await post('/auth/otp/verify', { challengeId, code })).statusCode).toBe(200);
    expect((await post('/auth/otp/verify', { challengeId, code })).statusCode).toBe(401);
  });

  it('stops accepting even the right code after 5 wrong attempts', async () => {
    const { challengeId } = await requestCode();
    const { code } = h.sentCodes.at(-1)!;
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++)
      expect((await post('/auth/otp/verify', { challengeId, code: wrong })).statusCode).toBe(401);
    expect((await post('/auth/otp/verify', { challengeId, code })).statusCode).toBe(401);
  });

  it('expires codes after 5 minutes', async () => {
    const { challengeId } = await requestCode();
    h.clock.advance(5 * 60 + 1);
    expect(
      (await post('/auth/otp/verify', { challengeId, code: h.sentCodes.at(-1)!.code })).statusCode,
    ).toBe(401);
  });

  it('limits how many codes a number can request', async () => {
    for (let i = 0; i < 3; i++) await requestCode();
    const res = await post('/auth/otp/request', { organisation: 'clinic-a', phone: '9876543210' });
    expect(res.statusCode).toBe(429);
    h.clock.advance(10 * 60 + 1);
    expect(
      (await post('/auth/otp/request', { organisation: 'clinic-a', phone: '9876543210' }))
        .statusCode,
    ).toBe(200);
  });

  it('rejects invalid numbers and unknown clinics', async () => {
    expect(
      (await post('/auth/otp/request', { organisation: 'clinic-a', phone: '12345 67890' })).json()
        .error.fields,
    ).toHaveProperty('phone');
    expect(
      (await post('/auth/otp/request', { organisation: 'no-such-clinic', phone: '9876543210' }))
        .statusCode,
    ).toBe(404);
  });

  it('does not let a patient use staff endpoints', async () => {
    const { challengeId } = await requestCode();
    const tokens = (
      await post('/auth/otp/verify', { challengeId, code: h.sentCodes.at(-1)!.code })
    ).json();
    expect(
      (await h.app.inject({ method: 'GET', url: '/v1/patients', headers: bearer(tokens) }))
        .statusCode,
    ).toBe(403);
  });
});

describe('staff sign-in with password and authenticator', () => {
  it('signs in with password then TOTP', async () => {
    const tokens = await staffLogin(h, 'clinic-a', clinics.a.doctor);
    const me = (
      await h.app.inject({ method: 'GET', url: '/v1/me', headers: bearer(tokens) })
    ).json();
    expect(me).toMatchObject({ role: 'doctor', organisation: { slug: 'clinic-a' } });
  });

  it('never offers authenticator enrolment at login, even with the right password', async () => {
    const user = await h.owner.user.create({
      data: { email: 'new.staff@clinic-a.test', passwordHash: await hashPassword(STAFF_PASSWORD) },
    });
    await h.owner.membership.create({
      data: { organisationId: clinics.a.org.id, userId: user.id, role: 'front_desk' },
    });

    const res = await post('/auth/login', {
      organisation: 'clinic-a',
      identifier: 'NEW.STAFF@clinic-a.test',
      password: STAFF_PASSWORD,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.message).toMatch(/invite link/);
    expect(res.json()).not.toHaveProperty('otpauthUri');
    const stored = await h.owner.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(stored.mfaSecret).toBeNull();
    expect(stored.mfaPendingSecret).toBeNull();
  });

  it('rejects a TOTP code that was already used', async () => {
    const doctor = clinics.a.doctor;
    const login = async () =>
      (
        await post('/auth/login', {
          organisation: 'clinic-a',
          identifier: doctor.email,
          password: STAFF_PASSWORD,
        })
      ).json().mfaToken;
    const code = totpAt(doctor.totpSecret, h.clock.ms / 1000);
    expect((await post('/auth/mfa/verify', { mfaToken: await login(), code })).statusCode).toBe(
      200,
    );
    expect((await post('/auth/mfa/verify', { mfaToken: await login(), code })).statusCode).toBe(
      401,
    );
  });

  it('gives the same answer for an unknown user and a wrong password', async () => {
    const unknown = await post('/auth/login', {
      organisation: 'clinic-a',
      identifier: 'nobody@clinic-a.test',
      password: 'x',
    });
    const wrong = await post('/auth/login', {
      organisation: 'clinic-a',
      identifier: clinics.a.doctor.email,
      password: 'x',
    });
    expect(unknown.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    expect(unknown.json().error.message).toBe(wrong.json().error.message);
  });

  it('locks the account for 15 minutes after 5 wrong passwords', async () => {
    const attempt = (password: string) =>
      post('/auth/login', {
        organisation: 'clinic-a',
        identifier: clinics.a.doctor.email,
        password,
      });
    for (let i = 0; i < 5; i++) expect((await attempt('wrong')).statusCode).toBe(401);
    expect((await attempt(STAFF_PASSWORD)).statusCode).toBe(429);
    h.clock.advance(15 * 60 + 1);
    expect((await attempt(STAFF_PASSWORD)).statusCode).toBe(200);
  });

  describe('at the authenticator step', () => {
    const passwordStep = () =>
      post('/auth/login', {
        organisation: 'clinic-a',
        identifier: clinics.a.doctor.email,
        password: STAFF_PASSWORD,
      });
    const codeStep = (step: { json: () => { mfaToken: string } }, code: string) =>
      post('/auth/mfa/verify', { mfaToken: step.json().mfaToken, code });
    const liveSessions = () =>
      h.owner.session.count({ where: { userId: clinics.a.doctor.userId, revokedAt: null } });

    it('locks after wrong codes even when each sign-in starts with the right password', async () => {
      // Someone who knows the password guesses codes across sign-ins: the password step
      // must not wipe the count.
      for (let i = 0; i < 5; i++) {
        const step = await passwordStep();
        expect(step.statusCode, `attempt ${i + 1}`).toBe(200);
        expect((await codeStep(step, WRONG_CODE)).statusCode).toBe(401);
      }
      expect((await passwordStep()).statusCode).toBe(429);
      const row = await h.owner.user.findUniqueOrThrow({
        where: { id: clinics.a.doctor.userId },
      });
      expect(row.lockedUntil?.getTime()).toBe(h.clock.ms + 15 * 60_000);
    });

    it('a right code resets the count', async () => {
      for (let i = 0; i < 4; i++) {
        expect((await codeStep(await passwordStep(), WRONG_CODE)).statusCode).toBe(401);
      }
      await staffLogin(h, 'clinic-a', clinics.a.doctor);
      const row = await h.owner.user.findUniqueOrThrow({
        where: { id: clinics.a.doctor.userId },
      });
      expect(row.failedLoginCount).toBe(0);
    });

    it('accepts one code once, even when two requests race with it', async () => {
      const [first, second] = await Promise.all([passwordStep(), passwordStep()]);
      h.clock.advance(30);
      const code = totpAt(clinics.a.doctor.totpSecret, h.clock.ms / 1000);
      const results = await Promise.all([codeStep(first!, code), codeStep(second!, code)]);
      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 401]);
      expect(await liveSessions()).toBe(1);
      // The loser is recorded as a reused code, wherever it lost (its read or its write).
      const failed = await h.owner.auditLog.findMany({ where: { action: 'auth.mfa.failed' } });
      expect(failed.map((a) => a.metadata)).toEqual([{ reason: 'code_reused' }]);
    });

    it.each([
      // As a clinic admin's or support's authenticator reset writes it.
      [
        'an authenticator reset',
        {
          passwordHash: null,
          mfaSecret: null,
          mfaPendingSecret: null,
          mfaLastUsedStep: null,
          failedLoginCount: 0,
          lockedUntil: null,
        },
      ],
      ['a disable', { status: 'disabled' as const }],
    ])('creates no session when %s commits during the code check', async (_, change) => {
      const step = await passwordStep();
      h.clock.advance(30);
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      let locked!: () => void;
      const rowLocked = new Promise<void>((resolve) => (locked = resolve));
      // Hold the user's row, so the code check reads it and then waits at its write.
      const changing = h.owner.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM users WHERE id = ${clinics.a.doctor.userId}::uuid FOR UPDATE`;
          locked();
          await held;
          await tx.user.update({ where: { id: clinics.a.doctor.userId }, data: change });
        },
        { timeout: 10_000 },
      );
      await rowLocked;
      const verify = codeStep(step, totpAt(clinics.a.doctor.totpSecret, h.clock.ms / 1000));
      await new Promise((resolve) => setTimeout(resolve, 300));
      release();
      await changing;
      expect((await verify).statusCode).toBe(401);
      expect(await liveSessions()).toBe(0);
      const failed = await h.owner.auditLog.findMany({ where: { action: 'auth.mfa.failed' } });
      expect(failed.map((a) => a.metadata)).toEqual([{ reason: 'changed_meanwhile' }]);
    });
  });

  it('asks which role to use when a person holds two staff roles', async () => {
    await h.owner.membership.create({
      data: {
        organisationId: clinics.a.org.id,
        userId: clinics.a.doctor.userId,
        role: 'clinic_admin',
      },
    });
    const body = {
      organisation: 'clinic-a',
      identifier: clinics.a.doctor.email,
      password: STAFF_PASSWORD,
    };
    const ambiguous = await post('/auth/login', body);
    expect(ambiguous.statusCode).toBe(400);
    expect(ambiguous.json().error.fields.role).toContain('doctor');
    expect((await post('/auth/login', { ...body, role: 'clinic_admin' })).statusCode).toBe(200);
  });

  describe('while the password is checked', () => {
    afterEach(() => {
      passwordCheck.hook = undefined;
    });

    // scrypt is slow by design; inside a transaction a busy CPU pushed it past Prisma's
    // 5 s interactive-transaction timeout and sign-in failed with a 500.
    it.each([
      ['the right password', STAFF_PASSWORD],
      ['a wrong password', 'wrong'],
    ])('keeps no transaction open (%s)', async (_, password) => {
      const open: number[] = [];
      passwordCheck.hook = async () => {
        const [row] = await h.owner.$queryRaw<{ n: number }[]>`
          SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND state LIKE 'idle in transaction%'`;
        open.push(row!.n);
      };
      const res = await post('/auth/login', {
        organisation: 'clinic-a',
        identifier: clinics.a.doctor.email,
        password,
      });
      expect(res.statusCode).toBe(password === STAFF_PASSWORD ? 200 : 401);
      expect(open).toEqual([0]);
    });

    const login = () =>
      post('/auth/login', {
        organisation: 'clinic-a',
        identifier: clinics.a.doctor.email,
        password: STAFF_PASSWORD,
      });
    const doctorRow = () =>
      h.owner.user.findUniqueOrThrow({ where: { id: clinics.a.doctor.userId } });

    it('refuses a password changed meanwhile and counts it as a failure', async () => {
      passwordCheck.hook = async () => {
        await h.owner.user.update({
          where: { id: clinics.a.doctor.userId },
          data: { passwordHash: await hashPassword('another-Passw0rd!') },
        });
      };
      expect((await login()).statusCode).toBe(401);
      expect((await doctorRow()).failedLoginCount).toBe(1);
    });

    it('refuses an account locked meanwhile', async () => {
      passwordCheck.hook = async () => {
        await h.owner.user.update({
          where: { id: clinics.a.doctor.userId },
          data: { lockedUntil: new Date(h.clock.now().getTime() + 60_000) },
        });
      };
      expect((await login()).statusCode).toBe(429);
    });

    it('refuses a clinic suspended meanwhile', async () => {
      passwordCheck.hook = async () => {
        await h.owner.organisation.update({
          where: { slug: 'clinic-a' },
          data: { status: 'suspended' },
        });
      };
      expect((await login()).statusCode).toBe(401);
    });
  });

  it('locks the account when wrong passwords arrive at the same time', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        post('/auth/login', {
          organisation: 'clinic-a',
          identifier: clinics.a.doctor.email,
          password: 'wrong',
        }),
      ),
    );
    expect(results.every((r) => r.statusCode === 401 || r.statusCode === 429)).toBe(true);
    const row = await h.owner.user.findUniqueOrThrow({ where: { id: clinics.a.doctor.userId } });
    expect(row.lockedUntil?.getTime()).toBeGreaterThan(h.clock.now().getTime());
  });

  it('writes sign-in events to the audit log', async () => {
    await staffLogin(h, 'clinic-a', clinics.a.doctor);
    const actions = (
      await h.owner.auditLog.findMany({ where: { actorUserId: clinics.a.doctor.userId } })
    ).map((a) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining(['auth.session.created', 'auth.login.succeeded']),
    );
  });
});

describe('sessions', () => {
  it('rotates refresh tokens on each use', async () => {
    const first = await staffLogin(h, 'clinic-a', clinics.a.doctor);
    const res = await post('/auth/refresh', { refreshToken: first.refreshToken });
    expect(res.statusCode).toBe(200);
    const second = TokenResponse.parse(res.json());
    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(
      (await h.app.inject({ method: 'GET', url: '/v1/me', headers: bearer(second) })).statusCode,
    ).toBe(200);
  });

  it('ends the whole session when an old refresh token is replayed', async () => {
    const first = await staffLogin(h, 'clinic-a', clinics.a.doctor);
    const second = TokenResponse.parse(
      (await post('/auth/refresh', { refreshToken: first.refreshToken })).json(),
    );

    expect((await post('/auth/refresh', { refreshToken: first.refreshToken })).statusCode).toBe(
      401,
    );
    // The legitimate holder is signed out too, and so is the attacker.
    expect((await post('/auth/refresh', { refreshToken: second.refreshToken })).statusCode).toBe(
      401,
    );
    expect(
      (await h.app.inject({ method: 'GET', url: '/v1/me', headers: bearer(second) })).statusCode,
    ).toBe(401);
    expect(await h.owner.auditLog.count({ where: { action: 'auth.refresh.reuse_detected' } })).toBe(
      1,
    );
  });

  it('stops an access token working as soon as the user logs out', async () => {
    const tokens = await staffLogin(h, 'clinic-a', clinics.a.doctor);
    expect((await post('/auth/logout', undefined, bearer(tokens))).statusCode).toBe(204);
    expect(
      (await h.app.inject({ method: 'GET', url: '/v1/me', headers: bearer(tokens) })).statusCode,
    ).toBe(401);
    expect((await post('/auth/refresh', { refreshToken: tokens.refreshToken })).statusCode).toBe(
      401,
    );
  });

  it('ends sessions when the membership is revoked', async () => {
    const tokens = await staffLogin(h, 'clinic-a', clinics.a.doctor);
    await h.owner.membership.updateMany({
      where: { userId: clinics.a.doctor.userId },
      data: { status: 'revoked' },
    });
    expect((await post('/auth/refresh', { refreshToken: tokens.refreshToken })).statusCode).toBe(
      401,
    );
  });

  it('rejects missing and forged tokens', async () => {
    expect((await h.app.inject({ method: 'GET', url: '/v1/me' })).statusCode).toBe(401);
    expect(
      (
        await h.app.inject({
          method: 'GET',
          url: '/v1/me',
          headers: { authorization: 'Bearer nope' },
        })
      ).statusCode,
    ).toBe(401);
  });
});
