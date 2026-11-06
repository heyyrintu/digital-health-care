import { withAuth, withPlatform, withTenant } from '@dhc/db';
import { afterAll, beforeEach, expect, it } from 'vitest';
import {
  createHarness,
  resetDatabase,
  seedTwoClinics,
  addOperator,
  STAFF_PASSWORD,
} from './harness';
import { hashPassword } from '../src/auth/password';
const h = createHarness();
let clinics: Awaited<ReturnType<typeof seedTwoClinics>>;
beforeEach(async () => {
  await resetDatabase(h.owner);
  h.clock.ms = Date.UTC(2026, 9, 6, 4, 30);
  clinics = await seedTwoClinics(h);
  h.sentCodes.length = 0;
  h.services.staffMfaMode = 'totp';
  h.services.platformMfaMode = 'totp';
  h.services.staffMfaPhones = {};
  h.services.platformMfaPhones = {};
});
afterAll(async () => {
  await h.app.close();
  await h.owner.$disconnect();
});
const post = (url: string, payload: object) =>
  h.app.inject({ method: 'POST', url: '/v1' + url, payload });
const login = (password = STAFF_PASSWORD, email = 'doctor@clinic-a.test') =>
  post('/auth/login', { organisation: 'clinic-a', identifier: email, password });
async function whatsappLogin() {
  h.services.staffMfaMode = 'whatsapp';
  h.services.staffMfaPhones = { 'doctor@clinic-a.test': '+919876543210' };
  const response = await login();
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json().method).toBe('whatsapp');
  return { mfaToken: response.json().mfaToken, code: h.sentCodes.at(-1)!.code };
}
it('password-only staff mode still requires the password, active account and membership', async () => {
  h.services.staffMfaMode = 'disabled';
  expect((await login('wrong')).statusCode).toBe(401);
  const response = await login();
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json()).toMatchObject({ status: 'signed_in', tokenType: 'Bearer' });
  await h.owner.membership.updateMany({
    where: { userId: clinics.a.doctor.userId },
    data: { status: 'revoked' },
  });
  expect((await login()).statusCode).toBe(401);
});
it('sends no OTP for an invalid password or unconfigured recipient; defaults to TOTP', async () => {
  expect((await login()).json().method).toBe('totp');
  h.services.staffMfaMode = 'whatsapp';
  expect((await login('wrong')).statusCode).toBe(401);
  expect((await login()).statusCode).toBe(503);
  expect(h.sentCodes).toHaveLength(0);
});
it('uses a single-use OTP bound to the password step and isolated from patient OTP', async () => {
  const first = await whatsappLogin();
  const second = await whatsappLogin();
  expect(first.mfaToken).not.toBe(second.mfaToken);
  const rows = await h.owner.mfaOtpChallenge.findMany();
  expect(rows.every((r) => r.codeHash !== first.code && r.tokenHash !== first.mfaToken)).toBe(true);
  const patient = await post('/auth/otp/verify', { challengeId: rows[0]!.id, code: first.code });
  expect(patient.statusCode).toBe(401);
  const verified = await post('/auth/mfa/verify', first);
  expect(verified.statusCode, verified.body).toBe(200);
  expect((await post('/auth/mfa/verify', first)).statusCode).toBe(401);
  expect((await post('/platform/auth/mfa/verify', second)).statusCode).toBe(401);
});
it('rejects expired codes and challenges after a password change', async () => {
  const first = await whatsappLogin();
  h.clock.advance(301);
  expect((await post('/auth/mfa/verify', first)).statusCode).toBe(401);
  const next = await whatsappLogin();
  await h.owner.user.update({
    where: { id: clinics.a.doctor.userId },
    data: { passwordHash: await hashPassword('changed-synthetic-password') },
  });
  expect((await post('/auth/mfa/verify', next)).statusCode).toBe(401);
});
it('locks out guessing across OTP challenges and throttles sends', async () => {
  const first = await whatsappLogin();
  const wrong = first.code === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++)
    expect((await post('/auth/mfa/verify', { ...first, code: wrong })).statusCode).toBe(401);
  expect((await post('/auth/mfa/verify', first)).statusCode).toBe(429);
  expect((await login()).statusCode).toBe(429);
});
it('limits code requests and never falls back when delivery fails', async () => {
  await whatsappLogin();
  await whatsappLogin();
  await whatsappLogin();
  expect((await login()).statusCode).toBe(429);
  h.clock.advance(601);
  const original = h.services.otpSender;
  h.services.otpSender = {
    send: async () => {
      throw new Error('Synthetic failure');
    },
  };
  try {
    expect((await login()).statusCode).toBe(503);
    const rows = await h.owner.mfaOtpChallenge.findMany({ orderBy: { createdAt: 'desc' } });
    expect(rows[0]!.consumedAt).not.toBeNull();
    expect(rows[0]!.deliveredAt).toBeNull();
  } finally {
    h.services.otpSender = original;
  }
});
it('supports independent platform password-only and WhatsApp modes with recipient binding', async () => {
  const operator = await addOperator(h);
  const credentials = { email: operator.email, password: STAFF_PASSWORD };
  h.services.platformMfaMode = 'disabled';
  expect(
    (await post('/platform/auth/login', { ...credentials, password: 'wrong' })).statusCode,
  ).toBe(401);
  const direct = await post('/platform/auth/login', credentials);
  expect(direct.statusCode, direct.body).toBe(200);
  expect(direct.json().status).toBe('signed_in');
  h.services.platformMfaMode = 'whatsapp';
  expect((await post('/platform/auth/login', credentials)).statusCode).toBe(503);
  h.services.platformMfaPhones = { [operator.email]: '+919000000001' };
  const pending = await post('/platform/auth/login', credentials);
  expect(pending.statusCode, pending.body).toBe(200);
  const verify = { mfaToken: pending.json().mfaToken, code: h.sentCodes.at(-1)!.code };
  expect((await post('/auth/mfa/verify', verify)).statusCode).toBe(401);
  const signed = await post('/platform/auth/mfa/verify', verify);
  expect(signed.statusCode, signed.body).toBe(200);
  expect((await post('/platform/auth/mfa/verify', verify)).statusCode).toBe(401);
  expect(h.services.staffMfaMode).toBe('totp');
});

it('database roles cannot read the other audience or expose OTPs to clinic sessions', async () => {
  await whatsappLogin();
  const op = await addOperator(h);
  h.services.platformMfaMode = 'whatsapp';
  h.services.platformMfaPhones = { [op.email]: '+919000000001' };
  expect(
    (await post('/platform/auth/login', { email: op.email, password: STAFF_PASSWORD })).statusCode,
  ).toBe(200);
  const staffRows = await withAuth(h.services.db, (tx) => tx.mfaOtpChallenge.findMany());
  const operatorRows = await withPlatform(h.services.db, (tx) => tx.mfaOtpChallenge.findMany());
  expect(staffRows).toHaveLength(1);
  expect(staffRows[0]!.audience).toBe('staff');
  expect(operatorRows).toHaveLength(1);
  expect(operatorRows[0]!.audience).toBe('platform');
  await expect(
    withTenant(h.services.db, clinics.a.org.id, (tx) => tx.mfaOtpChallenge.findMany()),
  ).rejects.toThrow();
});

it.each(['staff', 'platform'] as const)(
  'password-only %s sign-in cannot clear a concurrent account lock',
  async (audience) => {
    const platform = audience === 'platform';
    const operator = platform ? await addOperator(h) : null;
    h.services.staffMfaMode = 'disabled';
    h.services.platformMfaMode = 'disabled';
    const id = operator?.operatorId ?? clinics.a.doctor.userId;
    let release!: () => void;
    let announce!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const locked = new Promise<void>((resolve) => {
      announce = resolve;
    });
    const until = new Date(h.clock.ms + 15 * 60_000);
    const changing = h.owner.$transaction(
      async (tx) => {
        if (platform)
          await tx.$queryRaw`SELECT id FROM platform_operators WHERE id = ${id}::uuid FOR UPDATE`;
        else await tx.$queryRaw`SELECT id FROM users WHERE id = ${id}::uuid FOR UPDATE`;
        announce();
        await held;
        if (platform)
          await tx.platformOperator.update({
            where: { id },
            data: { lockedUntil: until, failedLoginCount: 0 },
          });
        else
          await tx.user.update({
            where: { id },
            data: { lockedUntil: until, failedLoginCount: 0 },
          });
      },
      { timeout: 10000 },
    );
    await locked;
    const signingIn = platform
      ? post('/platform/auth/login', { email: operator!.email, password: STAFF_PASSWORD })
      : login();
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
    } finally {
      release();
    }
    await changing;
    const response = await signingIn;
    expect([401, 429]).toContain(response.statusCode);
    const row = platform
      ? await h.owner.platformOperator.findUniqueOrThrow({ where: { id } })
      : await h.owner.user.findUniqueOrThrow({ where: { id } });
    expect(row.lockedUntil?.getTime()).toBe(until.getTime());
    expect(platform ? await h.owner.platformSession.count() : await h.owner.session.count()).toBe(
      0,
    );
  },
);
