import { afterAll, beforeEach, expect, it } from 'vitest';
import { withAuth, withTenant, withPlatform } from '@dhc/db';
import {
  createHarness,
  resetDatabase,
  seedTwoClinics,
  staffLogin,
  addStaff,
  bearer,
  STAFF_PASSWORD,
} from './harness';
import type { TokenResponse } from '@dhc/contracts';
const h = createHarness();
let testIp = 0;
let clinics: Awaited<ReturnType<typeof seedTwoClinics>>,
  admin: TokenResponse,
  doctor: TokenResponse,
  adminB: TokenResponse;
const delivered: { email: string; code: string }[] = [];
beforeEach(async () => {
  testIp++;
  await resetDatabase(h.owner);
  h.clock.ms = Date.UTC(2026, 9, 6, 4, 30);
  h.sentCodes.length = 0;
  delivered.length = 0;
  h.services.otpSender = {
    channel: 'whatsapp',
    send: async (phone, code) => void h.sentCodes.push({ phone, code }),
  };
  clinics = await seedTwoClinics(h);
  admin = await staffLogin(h, 'clinic-a', clinics.a.admin);
  doctor = await staffLogin(h, 'clinic-a', clinics.a.doctor);
  adminB = await staffLogin(h, 'clinic-b', clinics.b.admin);
  h.services.emailSender = {
    sendVerification: async (email, code) => {
      delivered.push({ email, code });
    },
  };
});
afterAll(async () => {
  await h.app.close();
  await h.owner.$disconnect();
});
const call = (method: string, path: string, token: TokenResponse, payload?: object) =>
  h.app.inject({
    method: method as 'GET',
    url: '/v1' + path,
    remoteAddress: `10.18.0.${testIp}`,
    headers: bearer(token),
    payload,
  });
const detail = async (id = clinics.a.doctor.userId) => {
  const r = await call('GET', '/staff/people/' + id, admin);
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
};
const update = async (id: string, patch: object = {}, token = admin) => {
  const d = await detail(id);
  return call('PATCH', '/staff/people/' + id, token, {
    version: d.version,
    displayName: d.displayName,
    roles: d.roles,
    enabled: true,
    ...patch,
  });
};
it('lists only own clinic staff, searches and rejects non-admins or other clinic targets', async () => {
  const list = await call('GET', '/staff/people', admin);
  expect(list.statusCode, list.body).toBe(200);
  const ids = list.json().data.map((r: { userId: string }) => r.userId);
  expect(ids).toContain(clinics.a.doctor.userId);
  expect(ids).not.toContain(clinics.b.doctor.userId);
  const search = await call('GET', '/staff/people?q=doctor', admin);
  expect(search.json().data).toHaveLength(1);
  expect((await call('GET', '/staff/people', doctor)).statusCode).toBe(403);
  expect((await call('GET', '/staff/people/' + clinics.a.doctor.userId, adminB)).statusCode).toBe(
    404,
  );
  const cursor = clinics.a.doctor.userId;
  const next = await call('GET', '/staff/people?cursor=' + cursor, admin);
  expect(
    next.json().data.every((r: { userId: string }) => ids.includes(r.userId) && r.userId > cursor),
  ).toBe(true);
});
it('edits profile and roles with optimistic checks, revokes sessions and records audit', async () => {
  const d = await detail();
  const saved = await call('PATCH', '/staff/people/' + d.userId, admin, {
    version: d.version,
    displayName: 'Updated Doctor',
    roles: ['doctor', 'front_desk'],
    enabled: true,
  });
  expect(saved.statusCode, saved.body).toBe(200);
  expect(saved.json().roles).toEqual(expect.arrayContaining(['doctor', 'front_desk']));
  expect((await call('GET', '/me', doctor)).statusCode).toBe(401);
  const stale = await call('PATCH', '/staff/people/' + d.userId, admin, {
    version: d.version,
    displayName: 'Stale name',
    roles: ['doctor'],
    enabled: true,
  });
  expect(stale.statusCode).toBe(409);
  expect(
    saved.json().audit.some((a: { action: string }) => a.action === 'staff.people.updated'),
  ).toBe(true);
});
it('keeps shared identities read-only but changes only this clinic access', async () => {
  const id = clinics.a.doctor.userId;
  await h.owner.membership.create({
    data: { organisationId: clinics.b.org.id, userId: id, role: 'doctor' },
  });
  const other = await staffLogin(h, 'clinic-b', clinics.a.doctor);
  expect((await detail()).identityEditable).toBe(false);
  expect((await update(id, { displayName: 'Forbidden rename' })).statusCode).toBe(409);
  const disabled = await update(id, { enabled: false });
  expect(disabled.statusCode, disabled.body).toBe(200);
  expect(disabled.json().status).toBe('disabled');
  expect((await call('GET', '/me', doctor)).statusCode).toBe(401);
  expect((await call('GET', '/me', other)).statusCode).toBe(200);
  const enabled = await update(id);
  expect(enabled.statusCode, enabled.body).toBe(200);
});
it('protects own admin access and prevents concurrent last-admin removal', async () => {
  expect((await update(clinics.a.admin.userId, { roles: ['doctor'] })).statusCode).toBe(409);
  expect((await update(clinics.a.admin.userId, { enabled: false })).statusCode).toBe(409);
  const extra = await addStaff(h, clinics.a.org.id, 'clinic_admin', 'second-admin@example.test');
  const second = await staffLogin(h, 'clinic-a', extra);
  const a = await detail(clinics.a.admin.userId),
    b = await detail(extra.userId);
  const results = await Promise.all([
    call('PATCH', '/staff/people/' + extra.userId, admin, {
      version: b.version,
      displayName: b.displayName,
      roles: b.roles,
      enabled: false,
    }),
    call('PATCH', '/staff/people/' + clinics.a.admin.userId, second, {
      version: a.version,
      displayName: a.displayName,
      roles: a.roles,
      enabled: false,
    }),
  ]);
  expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
  expect(
    await h.owner.membership.count({
      where: { organisationId: clinics.a.org.id, role: 'clinic_admin', status: 'active' },
    }),
  ).toBe(1);
});
async function requestContact(
  field: 'email' | 'phone',
  value: string,
  id = clinics.a.doctor.userId,
) {
  const d = await detail(id);
  return call('POST', '/staff/people/' + id + '/contact-changes', admin, {
    version: d.version,
    field,
    value,
    password: STAFF_PASSWORD,
  });
}
it('requires new-email verification by the staff owner and changes neither login before confirmation', async () => {
  const requested = await requestContact('email', 'new-doctor@example.test');
  expect(requested.statusCode, requested.body).toBe(201);
  const id = requested.json().id;
  expect(delivered[0]!.email).toBe('new-doctor@example.test');
  expect(
    (await h.owner.user.findUniqueOrThrow({ where: { id: clinics.a.doctor.userId } })).email,
  ).toBe(clinics.a.doctor.email);
  expect(
    (
      await call('POST', '/staff/profile/contact-changes/' + id + '/confirm', admin, {
        code: delivered[0]!.code,
        password: STAFF_PASSWORD,
      })
    ).statusCode,
  ).toBe(404);
  const own = await call('GET', '/staff/profile/contact-changes', doctor);
  expect(own.json().data[0].id).toBe(id);
  const wrong = delivered[0]!.code === '000000' ? '111111' : '000000';
  expect(
    (
      await call('POST', '/staff/profile/contact-changes/' + id + '/confirm', doctor, {
        code: wrong,
        password: STAFF_PASSWORD,
      })
    ).statusCode,
  ).toBe(400);
  const verified = await call('POST', '/staff/profile/contact-changes/' + id + '/confirm', doctor, {
    code: delivered[0]!.code,
    password: STAFF_PASSWORD,
  });
  expect(verified.statusCode, verified.body).toBe(200);
  expect(
    (await h.owner.user.findUniqueOrThrow({ where: { id: clinics.a.doctor.userId } })).email,
  ).toBe('new-doctor@example.test');
  expect((await call('GET', '/me', doctor)).statusCode).toBe(401);
  const stored = await h.owner.staffContactChange.findUniqueOrThrow({ where: { id } });
  expect(stored.encryptedValue).not.toContain('new-doctor');
  expect(stored.codeHash).not.toBe(delivered[0]!.code);
  expect(stored.consumedAt).not.toBeNull();
});
it('allows login between a contact request and confirmation, without invalidating the code', async () => {
  const pending = await requestContact('phone', '9876543210');
  expect(pending.statusCode, pending.body).toBe(201);
  const fresh = await staffLogin(h, 'clinic-a', clinics.a.doctor);
  const verified = await call(
    'POST',
    '/staff/profile/contact-changes/' + pending.json().id + '/confirm',
    fresh,
    { code: h.sentCodes.at(-1)!.code, password: STAFF_PASSWORD },
  );
  expect(verified.statusCode, verified.body).toBe(200);
  expect(
    (await h.owner.user.findUniqueOrThrow({ where: { id: clinics.a.doctor.userId } })).phone,
  ).toBe('+919876543210');
});
it('rejects duplicate contacts, patient/shared identities, cancelled and expired requests', async () => {
  expect((await requestContact('email', clinics.b.doctor.email)).statusCode).toBe(409);
  const pending = await requestContact('email', 'cancelled@example.test');
  expect(pending.statusCode, pending.body).toBe(201);
  await call(
    'POST',
    `/staff/people/${clinics.a.doctor.userId}/contact-changes/${pending.json().id}/cancel`,
    admin,
    {},
  );
  expect(
    (
      await call(
        'POST',
        '/staff/profile/contact-changes/' + pending.json().id + '/confirm',
        doctor,
        { code: delivered.at(-1)!.code, password: STAFF_PASSWORD },
      )
    ).statusCode,
  ).toBe(400);
  const expired = await requestContact('email', 'expired@example.test');
  expect(expired.statusCode, expired.body).toBe(201);
  h.clock.advance(601);
  expect(
    (
      await call(
        'POST',
        '/staff/profile/contact-changes/' + expired.json().id + '/confirm',
        doctor,
        { code: delivered.at(-1)!.code, password: STAFF_PASSWORD },
      )
    ).statusCode,
  ).toBe(400);
  await h.owner.membership.create({
    data: { organisationId: clinics.a.org.id, userId: clinics.a.doctor.userId, role: 'patient' },
  });
  expect((await requestContact('email', 'patient@example.test')).statusCode).toBe(409);
});
it('fails closed on delivery failure and restricts the contact table to authentication code', async () => {
  h.services.emailSender = {
    sendVerification: async () => {
      throw new Error('Synthetic delivery failure');
    },
  };
  const failed = await requestContact('email', 'failed@example.test');
  expect(failed.statusCode).toBe(503);
  expect(
    (await h.owner.user.findUniqueOrThrow({ where: { id: clinics.a.doctor.userId } })).email,
  ).toBe(clinics.a.doctor.email);
  expect((await h.owner.staffContactChange.findFirstOrThrow()).cancelledAt).not.toBeNull();
  expect(await withAuth(h.services.db, (tx) => tx.staffContactChange.count())).toBe(1);
  await expect(
    withTenant(h.services.db, clinics.a.org.id, (tx) => tx.staffContactChange.count()),
  ).rejects.toThrow();
  await expect(
    withPlatform(h.services.db, (tx) => tx.staffContactChange.count()),
  ).rejects.toThrow();
});

it('does not apply a pending contact after the identity joins another clinic', async () => {
  const pending = await requestContact('email', 'shared-later@example.test');
  expect(pending.statusCode, pending.body).toBe(201);
  await h.owner.membership.create({
    data: {
      organisationId: clinics.b.org.id,
      userId: clinics.a.doctor.userId,
      role: 'doctor',
      status: 'invited',
    },
  });
  const confirm = await call(
    'POST',
    '/staff/profile/contact-changes/' + pending.json().id + '/confirm',
    doctor,
    { code: delivered[0]!.code, password: STAFF_PASSWORD },
  );
  expect(confirm.statusCode).toBe(409);
  expect(
    (await h.owner.user.findUniqueOrThrow({ where: { id: clinics.a.doctor.userId } })).email,
  ).toBe(clinics.a.doctor.email);
  expect(
    (
      await call(
        'POST',
        '/staff/members/' + clinics.a.doctor.userId + '/reset-authenticator',
        admin,
        {},
      )
    ).statusCode,
  ).toBe(409);
});

it('limits verification requests, preserves old details after wrong passwords and blocks code guessing', async () => {
  const d = await detail();
  const bad = await call('POST', '/staff/people/' + d.userId + '/contact-changes', admin, {
    version: d.version,
    field: 'email',
    value: 'unverified@example.test',
    password: 'wrong',
  });
  expect(bad.statusCode).toBe(400);
  expect(delivered).toHaveLength(0);
  const pending = await requestContact('email', 'guessing@example.test');
  expect(pending.statusCode, pending.body).toBe(201);
  const wrong = delivered[0]!.code === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++)
    expect(
      (
        await call(
          'POST',
          '/staff/profile/contact-changes/' + pending.json().id + '/confirm',
          doctor,
          { code: wrong, password: STAFF_PASSWORD },
        )
      ).statusCode,
    ).toBe(400);
  expect(
    (
      await call(
        'POST',
        '/staff/profile/contact-changes/' + pending.json().id + '/confirm',
        doctor,
        { code: delivered[0]!.code, password: STAFF_PASSWORD },
      )
    ).statusCode,
  ).toBe(429);
  expect((await h.owner.user.findUniqueOrThrow({ where: { id: d.userId } })).email).toBe(
    clinics.a.doctor.email,
  );
});

it('limits new verification sends to three per person per ten minutes', async () => {
  for (let i = 0; i < 3; i++)
    expect((await requestContact('email', `request${i}@example.test`)).statusCode).toBe(201);
  expect((await requestContact('email', 'too-many@example.test')).statusCode).toBe(429);
  expect(delivered).toHaveLength(3);
});
it('serialises authenticator reset against a competing admin access removal', async () => {
  const extra = await addStaff(h, clinics.a.org.id, 'clinic_admin', 'reset-race@example.test');
  const second = await staffLogin(h, 'clinic-a', extra);
  const a = await detail(clinics.a.admin.userId);
  const outcomes = await Promise.all([
    call('POST', '/staff/members/' + extra.userId + '/reset-authenticator', admin, {}),
    call('PATCH', '/staff/people/' + clinics.a.admin.userId, second, {
      version: a.version,
      displayName: a.displayName,
      roles: a.roles,
      enabled: false,
    }),
  ]);
  expect(outcomes.filter((r) => r.statusCode === 200 || r.statusCode === 201)).toHaveLength(1);
  expect(
    await h.owner.membership.count({
      where: {
        organisationId: clinics.a.org.id,
        role: 'clinic_admin',
        status: 'active',
        user: { status: 'active', passwordHash: { not: null }, mfaSecret: { not: null } },
      },
    }),
  ).toBe(1);
});

it('restores only the roles retained when access was disabled', async () => {
  const id = clinics.a.doctor.userId;
  expect((await update(id, { roles: ['doctor', 'front_desk', 'clinic_admin'] })).statusCode).toBe(
    200,
  );
  expect((await update(id, { roles: ['doctor'] })).statusCode).toBe(200);
  expect((await update(id, { enabled: false })).statusCode).toBe(200);
  const disabled = await detail(id);
  expect(disabled.roles).toEqual(['doctor']);
  expect((await update(id, { roles: disabled.roles })).statusCode).toBe(200);
  expect((await detail(id)).roles).toEqual(['doctor']);
});
it('rejects unavailable phone delivery without cancelling an existing request', async () => {
  const first = await requestContact('phone', '+919876543210');
  expect(first.statusCode, first.body).toBe(201);
  const count = await h.owner.staffContactChange.count();
  h.services.otpSender = { send: async () => {} };
  expect((await requestContact('phone', '+919876543211')).statusCode).toBe(503);
  expect(await h.owner.staffContactChange.count()).toBe(count);
  expect(
    (await h.owner.staffContactChange.findUniqueOrThrow({ where: { id: first.json().id } }))
      .cancelledAt,
  ).toBeNull();
});

it('requires invitation acceptance even when an existing account already has credentials', async () => {
  const id = clinics.a.doctor.userId;
  await h.owner.membership.updateMany({
    where: { organisationId: clinics.a.org.id, userId: id },
    data: { status: 'invited' },
  });
  expect((await update(id)).statusCode).toBe(409);
  expect((await update(id, { enabled: false, roles: ['front_desk'] })).statusCode).toBe(409);
  expect(
    await h.owner.membership.count({
      where: { organisationId: clinics.a.org.id, userId: id, status: 'active' },
    }),
  ).toBe(0);
});
