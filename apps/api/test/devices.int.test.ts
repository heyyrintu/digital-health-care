import { PushDevice, PushDeviceList, type TokenResponse } from '@dhc/contracts';
import { withAuth, withTenant } from '@dhc/db';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pushTargets } from '../src/modules/devices/revoke';
import {
  addStaff,
  bearer,
  createHarness,
  resetDatabase,
  seedTwoClinics,
  staffLogin,
  type StaffFixture,
} from './harness';

const h = createHarness();
let clinics: Awaited<ReturnType<typeof seedTwoClinics>>;
let adminA: TokenResponse;
let doctorA: TokenResponse;
let desk: StaffFixture;
let deskA: TokenResponse;

const TOKEN = 'ExponentPushToken[synthetic-ipad-0001]';
const PHONE = 'ExponentPushToken[synthetic-phone-0002]';

beforeEach(async () => {
  h.clock.ms = Date.UTC(2026, 9, 6, 4, 30);
  await resetDatabase(h.owner);
  clinics = await seedTwoClinics(h);
  desk = await addStaff(h, clinics.a.org.id, 'front_desk', 'desk@clinic-a.test');
  adminA = await staffLogin(h, 'clinic-a', clinics.a.admin);
  doctorA = await staffLogin(h, 'clinic-a', clinics.a.doctor);
  deskA = await staffLogin(h, 'clinic-a', desk);
});

afterAll(async () => {
  await h.app.close();
  await h.owner.$disconnect();
});

const call = (method: string, url: string, tokens: TokenResponse, payload?: unknown) =>
  h.app.inject({
    method: method as 'GET',
    url: `/v1${url}`,
    headers: bearer(tokens),
    payload: payload as object,
  });

async function register(tokens: TokenResponse, expoPushToken = TOKEN, extra = {}) {
  const res = await call('POST', '/push-devices', tokens, {
    platform: 'ios',
    appVariant: 'clinic',
    expoPushToken,
    deviceName: 'Reception iPad',
    ...extra,
  });
  expect(res.statusCode, res.body).toBe(201);
  return PushDevice.parse(res.json());
}

const list = async (tokens: TokenResponse) =>
  PushDeviceList.parse((await call('GET', '/push-devices', tokens)).json()).data;

const targets = (userIds: string[], organisationId = clinics.a.org.id) =>
  withAuth(h.services.db, (tx) => pushTargets(tx, organisationId, userIds, h.clock.now()));

describe('push devices', () => {
  it('registers a device for the session, lists it without the token, and audits it', async () => {
    const device = await register(doctorA);
    expect(device).toMatchObject({
      platform: 'ios',
      appVariant: 'clinic',
      deviceName: 'Reception iPad',
      current: true,
    });
    expect(JSON.stringify(await list(doctorA))).not.toContain('synthetic-ipad');
    expect(await list(doctorA)).toHaveLength(1);
    expect(await list(deskA)).toEqual([]);

    // Registering the same token again on the same session only refreshes it.
    await register(doctorA);
    const audits = await h.owner.auditLog.findMany({ where: { action: 'push_device.registered' } });
    expect(audits).toMatchObject([
      {
        organisationId: clinics.a.org.id,
        actorUserId: clinics.a.doctor.userId,
        entityId: device.id,
        metadata: { platform: 'ios', appVariant: 'clinic', moved: false },
      },
    ]);
    expect(await targets([clinics.a.doctor.userId])).toEqual([
      { userId: clinics.a.doctor.userId, expoPushToken: TOKEN, appVariant: 'clinic' },
    ]);
  });

  it('moves a shared device to whoever signs in on it next', async () => {
    const first = await register(doctorA);
    const second = await register(deskA);
    expect(second.id).toBe(first.id);
    expect(await list(doctorA)).toEqual([]);
    expect(await list(deskA)).toHaveLength(1);
    expect(await targets([clinics.a.doctor.userId, desk.userId])).toEqual([
      expect.objectContaining({ userId: desk.userId }),
    ]);
  });

  it('refuses tokens that are not Expo push tokens', async () => {
    for (const expoPushToken of ['abc', 'ExponentPushToken[short]', 'FCM[synthetic-ipad-0001]']) {
      const res = await call('POST', '/push-devices', doctorA, {
        platform: 'android',
        appVariant: 'clinic',
        expoPushToken,
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it('lets people remove only their own devices', async () => {
    const device = await register(doctorA);
    expect((await call('DELETE', `/push-devices/${device.id}`, deskA)).statusCode).toBe(404);
    expect((await call('DELETE', `/push-devices/${device.id}`, doctorA)).statusCode).toBe(204);
    expect((await call('DELETE', `/push-devices/${device.id}`, doctorA)).statusCode).toBe(404);
    expect(await list(doctorA)).toEqual([]);
    expect(await targets([clinics.a.doctor.userId])).toEqual([]);
  });

  it('stops pushing to a device when its session signs out, and only that one', async () => {
    const otherSession = await staffLogin(h, 'clinic-a', clinics.a.doctor);
    await register(doctorA, TOKEN);
    await register(otherSession, PHONE);
    expect((await list(doctorA)).map((d) => d.current).sort()).toEqual([false, true]);

    expect((await call('POST', '/auth/logout', doctorA)).statusCode).toBe(204);
    const row = await h.owner.pushDevice.findUniqueOrThrow({ where: { expoPushToken: TOKEN } });
    expect(row).toMatchObject({ revokedReason: 'logout' });
    expect(await targets([clinics.a.doctor.userId])).toEqual([
      expect.objectContaining({ expoPushToken: PHONE }),
    ]);
  });

  it('stops every device of a person whose authenticator is reset', async () => {
    const otherSession = await staffLogin(h, 'clinic-a', clinics.a.doctor);
    await register(doctorA, TOKEN);
    await register(otherSession, PHONE);
    const res = await call(
      'POST',
      `/staff/members/${clinics.a.doctor.userId}/reset-authenticator`,
      adminA,
      {},
    );
    expect(res.statusCode, res.body).toBe(201);
    const rows = await h.owner.pushDevice.findMany();
    expect(rows.map((r) => r.revokedReason)).toEqual([
      'authenticator_reset',
      'authenticator_reset',
    ]);
    expect(await targets([clinics.a.doctor.userId])).toEqual([]);
  });

  it('keeps clinics apart and refuses a device that does not match its session', async () => {
    await register(doctorA);
    expect(await targets([clinics.a.doctor.userId], clinics.b.org.id)).toEqual([]);

    const session = await h.owner.session.findFirstOrThrow({
      where: { userId: clinics.a.doctor.userId },
    });
    await expect(
      h.owner.pushDevice.create({
        data: {
          userId: clinics.a.doctor.userId,
          organisationId: clinics.b.org.id,
          sessionId: session.id,
          platform: 'android',
          appVariant: 'clinic',
          expoPushToken: PHONE,
        },
      }),
    ).rejects.toThrow(/match its session/);
    // Clinic queries cannot read devices at all (no grant to the clinic role).
    await expect(
      withTenant(h.services.db, clinics.a.org.id, (tx) => tx.pushDevice.count()),
    ).rejects.toThrow(/permission denied/);
  });
});
