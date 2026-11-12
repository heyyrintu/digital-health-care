import { drainSecurityDeliveries } from '../src/modules/account-security/routes';
import { AccountSecurityService } from '../src/modules/account-security/service';
import * as passwordPrimitives from '../src/auth/password';
import type { FastifyRequest } from 'fastify';
import { purgeAccountSecurityChallenges } from '../src/modules/account-security/purge';
import { withAuth, withPlatform, withTenant } from '@dhc/db';
import { beforeEach, afterAll, expect, it, vi } from 'vitest';
import { totpAt } from '../src/auth/totp';
import {
  STAFF_PASSWORD,
  addOperator,
  bearer,
  createHarness,
  platformLogin,
  resetDatabase,
  seedTwoClinics,
  staffLogin,
} from './harness';
const h = createHarness();
let clinics: Awaited<ReturnType<typeof seedTwoClinics>>;
const emails: { email: string; code: string; purpose: string }[] = [];
beforeEach(async () => {
  h.clock.ms = Date.UTC(2026, 9, 6, 4, 30);
  await resetDatabase(h.owner);
  clinics = await seedTwoClinics(h);
  emails.length = 0;
  h.sentCodes.length = 0;
  h.services.staffMfaMode = 'totp';
  h.services.platformMfaMode = 'totp';
  h.services.staffMfaPhones = {};
  h.services.platformMfaPhones = {};
  h.services.emailSender = {
    sendVerification: async () => {},
    sendSecurityCode: async (email, code, purpose) => {
      emails.push({ email, code, purpose });
    },
  };
  h.services.otpSender = {
    channel: 'whatsapp',
    send: async (phone, code) => {
      h.sentCodes.push({ phone, code });
    },
  };
});
afterAll(async () => {
  await h.app.close();
  await h.owner.$disconnect();
});
const post = async (
  path: string,
  body: Record<string, unknown>,
  headers?: Record<string, string>,
) => {
  const result = await h.app.inject({
    method: 'POST',
    url: '/v1' + path,
    payload: body,
    ...(headers ? { headers } : {}),
  });
  await drainSecurityDeliveries(h.services);
  return result;
};
const login = () =>
  post('/auth/login', {
    organisation: 'clinic-a',
    identifier: clinics.a.doctor.email,
    password: STAFF_PASSWORD,
  });
async function recovery(identifier = clinics.a.doctor.email, organisation = 'clinic-a') {
  const r = await post('/auth/password/request', { organisation, identifier });
  expect(r.statusCode).toBe(202);
  await vi.waitFor(async () => {
    const row = await h.owner.accountSecurityChallenge.findUnique({
      where: { id: r.json().challengeId },
    });
    expect(row?.deliveredAt).toBeTruthy();
  });
  return { challengeId: r.json().challengeId as string, code: emails.at(-1)!.code };
}
it('recovers without removing MFA, revokes sessions and invalidates pending password-step tokens', async () => {
  const tokens = await staffLogin(h, 'clinic-a', clinics.a.doctor);
  const oldMfa = (await login()).json().mfaToken;
  const c = await recovery();
  const newPassword = 'new synthetic passphrase 123';
  const userBefore = await h.owner.user.findUniqueOrThrow({
    where: { id: clinics.a.doctor.userId },
  });
  const reset = await post('/auth/password/confirm', {
    ...c,
    organisation: 'clinic-a',
    newPassword,
  });
  expect(reset.statusCode).toBe(204);
  const userAfter = await h.owner.user.findUniqueOrThrow({ where: { id: userBefore.id } });
  expect(userAfter.mfaSecret).toBe(userBefore.mfaSecret);
  expect(userAfter.authVersion).toBeGreaterThan(userBefore.authVersion);
  expect((await h.app.inject({ url: '/v1/me', headers: bearer(tokens) })).statusCode).toBe(401);
  h.clock.advance(30);
  expect(
    (
      await post('/auth/mfa/verify', {
        mfaToken: oldMfa,
        code: totpAt(clinics.a.doctor.totpSecret, h.clock.ms / 1000),
      })
    ).statusCode,
  ).toBe(401);
  expect(
    (await post('/auth/password/confirm', { ...c, organisation: 'clinic-a', newPassword }))
      .statusCode,
  ).toBe(400);
  expect((await login()).statusCode).toBe(401);
  expect(
    (
      await post('/auth/login', {
        organisation: 'clinic-a',
        identifier: clinics.a.doctor.email,
        password: newPassword,
      })
    ).json().method,
  ).toBe('totp');
  const audit = JSON.stringify(await h.owner.auditLog.findMany());
  expect(audit).not.toContain(c.code);
  expect(audit).not.toContain(newPassword);
});
it('acknowledges unknown identities identically and sends nothing', async () => {
  const r = await post('/auth/password/request', {
    organisation: 'clinic-a',
    identifier: 'missing@example.test',
  });
  expect(r.statusCode).toBe(202);
  expect(Object.keys(r.json()).sort()).toEqual(['challengeId', 'expiresAt']);
  expect(emails).toHaveLength(0);
  expect(await h.owner.accountSecurityChallenge.count()).toBe(0);
  expect(
    (
      await post('/auth/password/confirm', {
        challengeId: r.json().challengeId,
        organisation: 'clinic-a',
        code: '123456',
        newPassword: 'a new synthetic password',
      })
    ).statusCode,
  ).toBe(400);
});
it('bounds wrong guesses, expiry, recovery frequency and clinic scope', async () => {
  const c = await recovery();
  const body = { ...c, organisation: 'clinic-a', newPassword: 'a new synthetic password' };
  expect(
    (await post('/auth/password/confirm', { ...body, organisation: 'clinic-b' })).statusCode,
  ).toBe(400);
  const wrong = c.code === '000000' ? '111111' : '000000';
  for (let n = 0; n < 5; n++)
    expect((await post('/auth/password/confirm', { ...body, code: wrong })).statusCode).toBe(400);
  expect((await post('/auth/password/confirm', body)).statusCode).toBe(400);
  const second = await recovery();
  h.clock.advance(301);
  expect((await post('/auth/password/confirm', { ...body, ...second })).statusCode).toBe(400);
  await recovery();
  const sent = emails.length;
  expect(
    (
      await post('/auth/password/request', {
        organisation: 'clinic-a',
        identifier: clinics.a.doctor.email,
      })
    ).statusCode,
  ).toBe(202);
  expect(emails.length).toBe(sent);
});
it('retires undelivered recovery codes without leaking provider errors', async () => {
  h.services.emailSender!.sendSecurityCode = async () => {
    throw new Error('sensitive provider detail');
  };
  const r = await post('/auth/password/request', {
    organisation: 'clinic-a',
    identifier: clinics.a.doctor.email,
  });
  expect(r.statusCode).toBe(202);
  expect(r.body).not.toContain('sensitive');
  await vi.waitFor(async () => {
    expect(
      (
        await h.owner.accountSecurityChallenge.findUniqueOrThrow({
          where: { id: r.json().challengeId },
        })
      ).consumedAt,
    ).not.toBeNull();
  });
});
it('requires current proof to turn off MFA and ends existing sessions', async () => {
  const tokens = await staffLogin(h, 'clinic-a', clinics.a.doctor);
  const headers = bearer(tokens);
  const wrong = await post(
    '/auth/security/request',
    { password: 'wrong', method: 'disabled' },
    headers,
  );
  expect(wrong.statusCode).toBe(401);
  const pending = await post(
    '/auth/security/request',
    { password: STAFF_PASSWORD, method: 'disabled' },
    headers,
  );
  expect(pending.statusCode, pending.body).toBe(200);
  expect(
    (await post('/auth/security/confirm', { challengeId: pending.json().challengeId }, headers))
      .statusCode,
  ).toBe(400);
  h.clock.advance(30);
  const code = totpAt(clinics.a.doctor.totpSecret, h.clock.ms / 1000);
  expect(
    (
      await post(
        '/auth/security/confirm',
        { challengeId: pending.json().challengeId, currentCode: code },
        headers,
      )
    ).statusCode,
  ).toBe(204);
  expect(
    (await h.owner.user.findUniqueOrThrow({ where: { id: clinics.a.doctor.userId } })).mfaMode,
  ).toBe('disabled');
  expect((await login()).json().status).toBe('signed_in');
  expect((await h.app.inject({ url: '/v1/auth/security', headers })).statusCode).toBe(401);
});
it('enrols email by ownership proof, uses it at login and rejects replay', async () => {
  const tokens = await staffLogin(h, 'clinic-a', clinics.a.doctor),
    headers = bearer(tokens);
  const request = await post(
    '/auth/security/request',
    { password: STAFF_PASSWORD, method: 'email' },
    headers,
  );
  expect(request.statusCode).toBe(200);
  const newCode = emails.at(-1)!.code;
  h.clock.advance(30);
  expect(
    (
      await post(
        '/auth/security/confirm',
        {
          challengeId: request.json().challengeId,
          currentCode: totpAt(clinics.a.doctor.totpSecret, h.clock.ms / 1000),
          newCode,
        },
        headers,
      )
    ).statusCode,
  ).toBe(204);
  const second = (await login()).json();
  expect(second.method).toBe('email');
  const code = emails.at(-1)!.code;
  expect((await post('/auth/mfa/verify', { mfaToken: second.mfaToken, code })).statusCode).toBe(
    200,
  );
  expect((await post('/auth/mfa/verify', { mfaToken: second.mfaToken, code })).statusCode).toBe(
    401,
  );
});
it('rejects another account, old credentials and provider failure during setup', async () => {
  const tokens = await staffLogin(h, 'clinic-a', clinics.a.doctor),
    headers = bearer(tokens);
  const pending = await post(
    '/auth/security/request',
    { password: STAFF_PASSWORD, method: 'email' },
    headers,
  );
  const code = emails.at(-1)!.code;
  const other = await staffLogin(h, 'clinic-b', clinics.b.doctor);
  expect(
    (
      await post(
        '/auth/security/confirm',
        { challengeId: pending.json().challengeId, currentCode: code, newCode: code },
        bearer(other),
      )
    ).statusCode,
  ).toBe(400);
  await h.owner.user.update({
    where: { id: clinics.a.doctor.userId },
    data: { email: 'changed@clinic.test' },
  });
  h.clock.advance(30);
  expect(
    (
      await post(
        '/auth/security/confirm',
        {
          challengeId: pending.json().challengeId,
          currentCode: totpAt(clinics.a.doctor.totpSecret, h.clock.ms / 1000),
          newCode: code,
        },
        headers,
      )
    ).statusCode,
  ).toBe(400);
  h.services.emailSender!.sendSecurityCode = async () => {
    throw new Error('private provider body');
  };
  expect(
    (await post('/auth/security/request', { password: STAFF_PASSWORD, method: 'email' }, headers))
      .statusCode,
  ).toBe(503);
  expect(
    (await h.owner.user.findUniqueOrThrow({ where: { id: clinics.a.doctor.userId } })).mfaMode,
  ).toBeNull();
});
it('keeps platform recovery, settings and challenges isolated', async () => {
  const op = await addOperator(h);
  const tokens = await platformLogin(h, op);
  const headers = bearer(tokens);
  const change = await post(
    '/platform/auth/security/request',
    { password: STAFF_PASSWORD, method: 'disabled' },
    headers,
  );
  expect(change.statusCode).toBe(200);
  h.clock.advance(30);
  expect(
    (
      await post(
        '/platform/auth/security/confirm',
        {
          challengeId: change.json().challengeId,
          currentCode: totpAt(op.totpSecret, h.clock.ms / 1000),
        },
        headers,
      )
    ).statusCode,
  ).toBe(204);
  const request = await post('/platform/auth/password/request', { identifier: op.email });
  expect(request.statusCode).toBe(202);
  await vi.waitFor(async () =>
    expect(
      (
        await h.owner.accountSecurityChallenge.findUniqueOrThrow({
          where: { id: request.json().challengeId },
        })
      ).deliveredAt,
    ).toBeTruthy(),
  );
  const row = await h.owner.accountSecurityChallenge.findUniqueOrThrow({
    where: { id: request.json().challengeId },
  });
  expect(
    await withAuth(h.services.db, (tx) =>
      tx.accountSecurityChallenge.findUnique({ where: { id: row.id } }),
    ),
  ).toBeNull();
  expect(await withPlatform(h.services.db, (tx) => tx.accountSecurityChallenge.count())).toBe(2);
  await expect(
    withTenant(h.services.db, clinics.a.org.id, (tx) => tx.accountSecurityChallenge.count()),
  ).rejects.toThrow();
  const payload = {
    challengeId: row.id,
    code: emails.at(-1)!.code,
    newPassword: 'platform replacement password',
  };
  expect(
    (await post('/auth/password/confirm', { ...payload, organisation: 'clinic-a' })).statusCode,
  ).toBe(400);
  expect((await post('/platform/auth/password/confirm', payload)).statusCode).toBe(204);
  const updated = await h.owner.platformOperator.findUniqueOrThrow({
    where: { id: op.operatorId },
  });
  expect(updated.mfaMode).toBe('disabled');
});
it('serializes concurrent recovery confirmations so only one password update wins', async () => {
  const c = await recovery();
  const responses = await Promise.all(
    [0, 1].map((n) =>
      post('/auth/password/confirm', {
        ...c,
        organisation: 'clinic-a',
        newPassword: `synthetic concurrent password ${n}`,
      }),
    ),
  );
  expect(responses.map((r) => r.statusCode).sort()).toEqual([204, 400]);
});
it('proves a WhatsApp recipient before switching and permits restoring the authenticator', async () => {
  const tokens = await staffLogin(h, 'clinic-a', clinics.a.doctor),
    headers = bearer(tokens);
  h.services.staffMfaPhones = { [clinics.a.doctor.email]: '+919876543210' };
  const change = await post(
    '/auth/security/request',
    { password: STAFF_PASSWORD, method: 'whatsapp' },
    headers,
  );
  expect(change.statusCode).toBe(200);
  const newCode = h.sentCodes.at(-1)!.code;
  h.clock.advance(30);
  expect(
    (
      await post(
        '/auth/security/confirm',
        {
          challengeId: change.json().challengeId,
          currentCode: totpAt(clinics.a.doctor.totpSecret, h.clock.ms / 1000),
          newCode,
        },
        headers,
      )
    ).statusCode,
  ).toBe(204);
  const second = (await login()).json();
  expect(second.method).toBe('whatsapp');
  const signed = await post('/auth/mfa/verify', {
    mfaToken: second.mfaToken,
    code: h.sentCodes.at(-1)!.code,
  });
  expect(signed.statusCode).toBe(200);
  const nextHeaders = bearer(signed.json());
  const restore = await post(
    '/auth/security/request',
    { password: STAFF_PASSWORD, method: 'totp' },
    nextHeaders,
  );
  expect(restore.statusCode).toBe(200);
  const currentCode = h.sentCodes.at(-1)!.code;
  h.clock.advance(30);
  expect(
    (
      await post(
        '/auth/security/confirm',
        {
          challengeId: restore.json().challengeId,
          currentCode,
          newCode: totpAt(clinics.a.doctor.totpSecret, h.clock.ms / 1000),
        },
        nextHeaders,
      )
    ).statusCode,
  ).toBe(204);
  expect((await login()).json().method).toBe('totp');
});
it('enforces account lockouts when passwords are guessed in security settings', async () => {
  const tokens = await staffLogin(h, 'clinic-a', clinics.a.doctor),
    headers = bearer(tokens);
  for (let n = 0; n < 5; n++)
    expect(
      (await post('/auth/security/request', { password: 'incorrect', method: 'disabled' }, headers))
        .statusCode,
    ).toBe(401);
  expect(
    (
      await post(
        '/auth/security/request',
        { password: STAFF_PASSWORD, method: 'disabled' },
        headers,
      )
    ).statusCode,
  ).toBe(401);
  expect(
    (await h.owner.user.findUniqueOrThrow({ where: { id: clinics.a.doctor.userId } })).lockedUntil,
  ).not.toBeNull();
  expect(await h.owner.accountSecurityChallenge.count()).toBe(0);
});
it('does not send reset codes for suspended clinic memberships', async () => {
  await h.owner.membership.updateMany({
    where: { userId: clinics.a.doctor.userId },
    data: { status: 'suspended' },
  });
  const request = await post('/auth/password/request', {
    organisation: 'clinic-a',
    identifier: clinics.a.doctor.email,
  });
  expect(request.statusCode).toBe(202);
  expect(emails).toHaveLength(0);
});
it('blocks old authentication images from issuing sessions after account security changes', async () => {
  await h.owner.user.update({
    where: { id: clinics.a.doctor.userId },
    data: { mfaMode: 'disabled' },
  });
  const tokens = (await login()).json();
  expect(tokens.status).toBe('signed_in');
  const session = await h.owner.session.findFirstOrThrow({
    where: { userId: clinics.a.doctor.userId },
  });
  const { id: _id, ...data } = session;
  void _id;
  await expect(
    withAuth(h.services.db, (tx) =>
      tx.session.create({ data: { ...data, refreshTokenHash: 'synthetic-legacy-attempt' } }),
    ),
  ).rejects.toThrow();
  const op = await addOperator(h);
  await h.owner.platformOperator.update({
    where: { id: op.operatorId },
    data: { mfaMode: 'disabled' },
  });
  const platform = (
    await post('/platform/auth/login', { email: op.email, password: STAFF_PASSWORD })
  ).json();
  expect(platform.status).toBe('signed_in');
  const row = await h.owner.platformSession.findFirstOrThrow({
    where: { operatorId: op.operatorId },
  });
  const { id: _platformId, ...platformData } = row;
  void _platformId;
  await expect(
    withPlatform(h.services.db, (tx) =>
      tx.platformSession.create({
        data: { ...platformData, refreshTokenHash: 'synthetic-legacy-platform' },
      }),
    ),
  ).rejects.toThrow();
});

it('purges only security challenges expired more than 24 hours ago across both audiences', async () => {
  const current = await recovery();
  const expiresAt = new Date(h.clock.ms - 25 * 60 * 60_000);
  await h.owner.accountSecurityChallenge.createMany({
    data: ['staff', 'platform'].map((audience) => ({
      id: crypto.randomUUID(),
      audience,
      subjectId: clinics.a.doctor.userId,
      purpose: 'recovery',
      bindingHash: 'synthetic',
      newCodeHash: 'synthetic',
      createdAt: new Date(expiresAt.getTime() - 300_000),
      expiresAt,
    })),
  });
  await purgeAccountSecurityChallenges(h.services);
  expect(await h.owner.accountSecurityChallenge.count()).toBe(1);
  expect(
    await h.owner.accountSecurityChallenge.findUnique({ where: { id: current.challengeId } }),
  ).not.toBeNull();
});
it('uses personal methods for People readiness, enabling access, and retaining the last capable admin', async () => {
  const tokens = await staffLogin(h, 'clinic-a', clinics.a.admin),
    headers = bearer(tokens);
  await h.owner.user.update({
    where: { id: clinics.a.doctor.userId },
    data: { mfaMode: 'email', mfaSecret: null },
  });
  const detail = await h.app.inject({
    url: `/v1/staff/people/${clinics.a.doctor.userId}`,
    headers,
  });
  expect(detail.statusCode, detail.body).toBe(200);
  expect(detail.json().signInReady).toBe(true);
  expect(detail.json().secondFactorMode).toBe('email');
  const update = await h.app.inject({
    method: 'PATCH',
    url: `/v1/staff/people/${clinics.a.doctor.userId}`,
    headers,
    payload: {
      version: detail.json().version,
      displayName: detail.json().displayName,
      roles: ['doctor', 'clinic_admin'],
      enabled: true,
    },
  });
  expect(update.statusCode, update.body).toBe(200);
  const step = await post('/auth/login', {
    organisation: 'clinic-a',
    identifier: clinics.a.doctor.email,
    password: STAFF_PASSWORD,
    role: 'clinic_admin',
  });
  expect(step.statusCode, step.body).toBe(200);
  const signed = await post('/auth/mfa/verify', {
    mfaToken: step.json().mfaToken,
    code: emails.at(-1)!.code,
  });
  expect(signed.statusCode, signed.body).toBe(200);
  const actorHeaders = bearer(signed.json());
  const adminDetail = await h.app.inject({
    url: `/v1/staff/people/${clinics.a.admin.userId}`,
    headers: actorHeaders,
  });
  expect(adminDetail.statusCode).toBe(200);
  const sender = h.services.emailSender;
  h.services.emailSender = undefined;
  const unavailable = await h.app.inject({
    url: `/v1/staff/people/${clinics.a.doctor.userId}`,
    headers: actorHeaders,
  });
  expect(unavailable.json().signInReady).toBe(false);
  const blocked = await h.app.inject({
    method: 'PATCH',
    url: `/v1/staff/people/${clinics.a.admin.userId}`,
    headers: actorHeaders,
    payload: {
      version: adminDetail.json().version,
      displayName: null,
      roles: ['front_desk'],
      enabled: true,
    },
  });
  expect(blocked.statusCode, blocked.body).toBe(409);
  h.services.emailSender = sender;
  const demote = await h.app.inject({
    method: 'PATCH',
    url: `/v1/staff/people/${clinics.a.admin.userId}`,
    headers: actorHeaders,
    payload: {
      version: adminDetail.json().version,
      displayName: null,
      roles: ['front_desk'],
      enabled: true,
    },
  });
  expect(demote.statusCode, demote.body).toBe(200);
});

it('acknowledges recovery before looking up the supplied account', async () => {
  const spy = vi.spyOn(h.services.db, '$transaction');
  try {
    const service = new AccountSecurityService(h.services, 'staff');
    const pending = await service.requestRecovery(
      { id: 'synthetic-request', ip: '127.0.0.1', headers: {} } as FastifyRequest,
      clinics.a.doctor.email,
      'clinic-a',
    );
    expect(spy).not.toHaveBeenCalled();
    await pending.deliver();
    expect(spy).toHaveBeenCalled();
    expect(emails).toHaveLength(1);
  } finally {
    spy.mockRestore();
  }
});
it('rejects invalid reset challenges without performing password hashing', async () => {
  const spy = vi.spyOn(passwordPrimitives, 'hashPassword');
  try {
    const response = await post('/auth/password/confirm', {
      challengeId: crypto.randomUUID(),
      code: '123456',
      organisation: 'clinic-a',
      newPassword: 'synthetic replacement passphrase',
    });
    expect(response.statusCode).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  } finally {
    spy.mockRestore();
  }
});
