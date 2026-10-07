import type { TokenResponse } from '@dhc/contracts';
import { CreatedStaffInvite, StaffMemberList } from '@dhc/contracts';
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

const NEW_PASSWORD = 'a fresh synthetic passphrase';
const post = (url: string, payload?: unknown, headers?: Record<string, string>) =>
  h.app.inject({ method: 'POST', url: `/v1${url}`, payload: payload as object, headers });
const resetUrl = (userId: string) => `/staff/members/${userId}/reset-authenticator`;

async function reset(userId: string, tokens = adminA) {
  const res = await post(resetUrl(userId), {}, bearer(tokens));
  expect(res.statusCode, res.body).toBe(201);
  const created = CreatedStaffInvite.parse(res.json());
  return { created, token: new URL(created.inviteUrl).hash.slice(1) };
}

describe('staff list', () => {
  it('shows this clinic’s staff with their sign-in state, and no one else’s', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/v1/staff/members',
      headers: bearer(adminA),
    });
    const members = StaffMemberList.parse(res.json()).data;
    expect(members.map((m) => m.identifier).sort()).toEqual([
      clinics.a.admin.email,
      clinics.a.doctor.email,
    ]);
    expect(members.every((m) => m.status === 'active' && m.signInReady)).toBe(true);
  });

  it('is limited to clinic admins', async () => {
    const doctor = await staffLogin(h, 'clinic-a', clinics.a.doctor);
    const res = await h.app.inject({
      method: 'GET',
      url: '/v1/staff/members',
      headers: bearer(doctor),
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('authenticator reset', () => {
  it('signs the person out, clears their credentials and issues a reset link', async () => {
    const doctorTokens = await staffLogin(h, 'clinic-a', clinics.a.doctor);
    const { created, token } = await reset(clinics.a.doctor.userId);
    expect(created).toMatchObject({ role: 'doctor', status: 'pending' });

    // Existing sessions stop working at once.
    expect(
      (await h.app.inject({ method: 'GET', url: '/v1/me', headers: bearer(doctorTokens) }))
        .statusCode,
    ).toBe(401);
    expect(
      (await post('/auth/refresh', { refreshToken: doctorTokens.refreshToken })).statusCode,
    ).toBe(401);

    // The old password no longer gets anywhere.
    const login = await post('/auth/login', {
      organisation: 'clinic-a',
      identifier: clinics.a.doctor.email,
      password: STAFF_PASSWORD,
    });
    expect(login.statusCode).toBe(401);

    const details = (await post('/auth/invites/inspect', { token })).json();
    expect(details).toMatchObject({ purpose: 'reset', account: 'new', role: 'doctor' });

    const list = StaffMemberList.parse(
      (
        await h.app.inject({ method: 'GET', url: '/v1/staff/members', headers: bearer(adminA) })
      ).json(),
    ).data;
    expect(list.find((m) => m.userId === clinics.a.doctor.userId)).toMatchObject({
      status: 'active',
      signInReady: false,
    });
  });

  it('lets the person set a new password and authenticator, and only those work afterwards', async () => {
    const { token } = await reset(clinics.a.doctor.userId);
    const accept = await post('/auth/invites/accept', { token, password: NEW_PASSWORD });
    const secret = new URL(accept.json().otpauthUri).searchParams.get('secret')!;
    h.clock.advance(30);
    const complete = await post('/auth/invites/complete', {
      token,
      code: totpAt(secret, h.clock.ms / 1000),
    });
    expect(complete.statusCode, complete.body).toBe(200);

    // The membership was never removed, so the person keeps their role.
    const me = await h.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: bearer(complete.json()),
    });
    expect(me.json()).toMatchObject({ role: 'doctor', organisation: { slug: 'clinic-a' } });

    // The old authenticator is gone; the new one works.
    const login = async () =>
      (
        await post('/auth/login', {
          organisation: 'clinic-a',
          identifier: clinics.a.doctor.email,
          password: NEW_PASSWORD,
        })
      ).json().mfaToken;
    h.clock.advance(30);
    const oldCode = totpAt(clinics.a.doctor.totpSecret, h.clock.ms / 1000);
    expect(
      (await post('/auth/mfa/verify', { mfaToken: await login(), code: oldCode })).statusCode,
    ).toBe(401);
    h.clock.advance(30);
    const newCode = totpAt(secret, h.clock.ms / 1000);
    expect(
      (await post('/auth/mfa/verify', { mfaToken: await login(), code: newCode })).statusCode,
    ).toBe(200);

    const actions = (
      await h.owner.auditLog.findMany({ where: { organisationId: clinics.a.org.id } })
    ).map((a) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'staff.authenticator.reset',
        'staff.reset.link_created',
        'staff.reset.completed',
      ]),
    );
  });

  it('keeps only the newest reset link working', async () => {
    const first = await reset(clinics.a.doctor.userId);
    await reset(clinics.a.doctor.userId);
    expect((await post('/auth/invites/inspect', { token: first.token })).statusCode).toBe(404);
  });

  it('refuses a reset link if the person was removed from the clinic meanwhile', async () => {
    const { token } = await reset(clinics.a.doctor.userId);
    const accept = await post('/auth/invites/accept', { token, password: NEW_PASSWORD });
    const secret = new URL(accept.json().otpauthUri).searchParams.get('secret')!;
    await h.owner.membership.updateMany({
      where: { userId: clinics.a.doctor.userId },
      data: { status: 'revoked' },
    });
    h.clock.advance(30);
    expect(
      (await post('/auth/invites/complete', { token, code: totpAt(secret, h.clock.ms / 1000) }))
        .statusCode,
    ).toBe(404);
  });

  it('does not let an admin reset themselves', async () => {
    const res = await post(resetUrl(clinics.a.admin.userId), {}, bearer(adminA));
    expect(res.statusCode).toBe(409);
  });

  it('treats another clinic’s staff as not found', async () => {
    const res = await post(resetUrl(clinics.b.doctor.userId), {}, bearer(adminA));
    expect(res.statusCode).toBe(404);
    const stillWorks = await staffLogin(h, 'clinic-b', clinics.b.doctor);
    expect(stillWorks.accessToken).toBeTruthy();
  });

  it('refuses to reset someone who also works at another clinic', async () => {
    // Clinic B's doctor also joins clinic A.
    await h.owner.membership.create({
      data: { organisationId: clinics.a.org.id, userId: clinics.b.doctor.userId, role: 'doctor' },
    });
    const res = await post(resetUrl(clinics.b.doctor.userId), {}, bearer(adminA));
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/another clinic/);
    // Nothing was changed.
    const user = await h.owner.user.findUniqueOrThrow({ where: { id: clinics.b.doctor.userId } });
    expect(user.mfaSecret).not.toBeNull();
    expect(user.passwordHash).not.toBeNull();
  });

  it('is limited to clinic admins', async () => {
    const doctor = await staffLogin(h, 'clinic-a', clinics.a.doctor);
    expect((await post(resetUrl(clinics.a.admin.userId), {}, bearer(doctor))).statusCode).toBe(403);
  });

  it('only offers roles the person actually has', async () => {
    const res = await post(
      resetUrl(clinics.a.doctor.userId),
      { role: 'clinic_admin' },
      bearer(adminA),
    );
    expect(res.statusCode).toBe(400);
  });

  it('leaves the person’s patient sessions alone', async () => {
    // The doctor is also a patient elsewhere, signed in by mobile code.
    const phone = '+919811122233';
    await h.owner.user.update({ where: { id: clinics.a.doctor.userId }, data: { phone } });
    await h.owner.membership.create({
      data: { organisationId: clinics.b.org.id, userId: clinics.a.doctor.userId, role: 'patient' },
    });
    const otp = (await post('/auth/otp/request', { organisation: 'clinic-b', phone })).json();
    const patient = (
      await post('/auth/otp/verify', {
        challengeId: otp.challengeId,
        code: h.sentCodes.at(-1)!.code,
      })
    ).json();

    await reset(clinics.a.doctor.userId);
    expect(
      (await h.app.inject({ method: 'GET', url: '/v1/me', headers: bearer(patient) })).statusCode,
    ).toBe(200);
  });
});
