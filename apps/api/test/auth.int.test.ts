import { LoginResponse, MeResponse, OtpRequestResponse, TokenResponse } from '@dhc/contracts';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { base32Decode, totpAt } from '../src/auth/totp';
import { hashPassword } from '../src/auth/password';
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

  it('enrols an authenticator on first sign-in and requires it afterwards', async () => {
    const user = await h.owner.user.create({
      data: { email: 'new.staff@clinic-a.test', passwordHash: await hashPassword(STAFF_PASSWORD) },
    });
    await h.owner.membership.create({
      data: { organisationId: clinics.a.org.id, userId: user.id, role: 'front_desk' },
    });

    const first = LoginResponse.parse(
      (
        await post('/auth/login', {
          organisation: 'clinic-a',
          identifier: 'NEW.STAFF@clinic-a.test',
          password: STAFF_PASSWORD,
        })
      ).json(),
    );
    expect(first.status).toBe('mfa_enrolment_required');
    if (first.status !== 'mfa_enrolment_required') return;
    const secret = new URL(first.otpauthUri).searchParams.get('secret')!;
    expect(base32Decode(secret)).toHaveLength(20);

    const ok = await post('/auth/mfa/verify', {
      mfaToken: first.mfaToken,
      code: totpAt(secret, h.clock.ms / 1000),
    });
    expect(ok.statusCode).toBe(200);
    const stored = await h.owner.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(stored.mfaSecret).toBeTruthy();
    expect(stored.mfaSecret).not.toContain(secret);
    expect(stored.mfaPendingSecret).toBeNull();

    const second = (
      await post('/auth/login', {
        organisation: 'clinic-a',
        identifier: 'new.staff@clinic-a.test',
        password: STAFF_PASSWORD,
      })
    ).json();
    expect(second.status).toBe('mfa_required');
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
