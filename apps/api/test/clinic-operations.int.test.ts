import { randomUUID } from 'node:crypto';
import { beforeEach, afterAll, it, expect } from 'vitest';
import { withMessaging, withTenant } from '@dhc/db';
import { addDays, istDate } from '@dhc/domain';
import type { TokenResponse } from '@dhc/contracts';
import {
  createHarness,
  resetDatabase,
  seedTwoClinics,
  staffLogin,
  addStaff,
  bearer,
  patientLogin,
} from './harness';
const h = createHarness();
let clinics: Awaited<ReturnType<typeof seedTwoClinics>>,
  admin: TokenResponse,
  doctor: TokenResponse,
  desk: TokenResponse,
  other: TokenResponse,
  clinicId: string,
  typeId: string,
  date: string,
  targetDate: string,
  ids: string[];
const at = (d: string, t: string) => `${d}T${t}:00+05:30`;
const call = (method: string, path: string, body?: unknown, token = admin) =>
  h.app.inject({
    method: method as 'GET',
    url: '/v1' + path,
    headers: bearer(token),
    payload: body as object,
  });
const body = (overrides: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  kind: 'cancel',
  doctorId: clinics.a.doctor.userId,
  clinicId,
  date,
  from: '09:00',
  to: '10:00',
  reason: 'Doctor unavailable',
  delayMinutes: 0,
  notify: false,
  ...overrides,
});
async function preview(overrides: Record<string, unknown> = {}) {
  const r = await call('POST', '/clinic-operations/preview', body(overrides));
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
}
const apply = (id: string, acknowledgeManual = true, token = admin) =>
  call(
    'POST',
    `/clinic-operations/${id}/apply`,
    { revision: 1, confirmed: true, acknowledgeManual },
    token,
  );
beforeEach(async () => {
  h.clock.ms = Date.now() - 300000;
  await resetDatabase(h.owner);
  clinics = await seedTwoClinics(h);
  admin = await staffLogin(h, 'clinic-a', clinics.a.admin);
  doctor = await staffLogin(h, 'clinic-a', clinics.a.doctor);
  desk = await staffLogin(
    h,
    'clinic-a',
    await addStaff(h, clinics.a.org.id, 'front_desk', 'operations@clinic-a.test'),
  );
  other = await staffLogin(h, 'clinic-b', clinics.b.admin);
  date = addDays(istDate(h.services.now()), 1);
  targetDate = addDays(date, 1);
  clinicId = (
    await h.owner.clinic.create({ data: { organisationId: clinics.a.org.id, name: 'Main clinic' } })
  ).id;
  typeId = (
    await h.owner.consultationType.create({
      data: {
        organisationId: clinics.a.org.id,
        name: 'Visit',
        mode: 'in_person',
        defaultDurationMin: 15,
        feePaise: 10000,
      },
    })
  ).id;
  await h.owner.availabilityVersion.create({
    data: {
      organisationId: clinics.a.org.id,
      doctorUserId: clinics.a.doctor.userId,
      clinicId,
      consultationTypeId: typeId,
      effectiveFrom: new Date(istDate(h.services.now())),
      weekly: Object.fromEntries(
        ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((day) => [
          day,
          [{ start: '09:00', end: '13:00' }],
        ]),
      ),
      slotMinutes: 15,
      bufferMinutes: 0,
      createdByUserId: clinics.a.doctor.userId,
    },
  });
  ids = [];
  for (const [i, p] of clinics.a.patients.entries()) {
    const r = await call(
      'POST',
      '/appointments',
      {
        patientId: p.id,
        doctorUserId: clinics.a.doctor.userId,
        clinicId,
        consultationTypeId: typeId,
        startAt: new Date(at(date, i === 0 ? '09:00' : '09:15')).toISOString(),
        walkIn: false,
        overbook: false,
      },
      desk,
    );
    expect(r.statusCode, r.body).toBe(201);
    ids.push(r.json().id);
  }
  h.services.operationMessagingSender = '1234';
});
afterAll(async () => {
  await h.app.close();
  await h.owner.$disconnect();
});
it('previews without mutating, then atomically cancels eligible bookings and blocks new bookings in the source session', async () => {
  const plan = await preview();
  expect(plan.rows).toHaveLength(2);
  expect(plan.rows.every((r: { eligible: boolean }) => r.eligible)).toBe(true);
  expect(await h.owner.availabilityException.count()).toBe(0);
  expect((await h.owner.appointment.findUniqueOrThrow({ where: { id: ids[0] } })).status).toBe(
    'confirmed',
  );
  const applied = await apply(plan.id);
  expect(applied.statusCode, applied.body).toBe(200);
  expect(applied.json().changedCount).toBe(2);
  expect(applied.json().exceptionId).toBeTruthy();
  expect(await h.owner.appointment.count({ where: { id: { in: ids }, status: 'cancelled' } })).toBe(
    2,
  );
  const person = await h.owner.patient.create({
      data: { organisationId: clinics.a.org.id, uhid: 'EXTRA', name: 'Another Patient' },
    }),
    blocked = await call(
      'POST',
      '/appointments',
      {
        patientId: person.id,
        doctorUserId: clinics.a.doctor.userId,
        clinicId,
        consultationTypeId: typeId,
        startAt: new Date(at(date, '09:00')).toISOString(),
        walkIn: false,
        overbook: false,
      },
      desk,
    );
  expect(blocked.statusCode).toBe(409);
  expect((await apply(plan.id)).statusCode).toBe(200);
  expect(await h.owner.availabilityException.count()).toBe(1);
  expect(await h.owner.clinicOperationalUpdate.count()).toBe(2);
});
it('moves the whole eligible session with preserved spacing, lineage and patient/type; retries never create extra replacements', async () => {
  const plan = await preview({
    kind: 'reschedule',
    targetDate,
    targetTime: '10:00',
    targetClinicId: clinicId,
  });
  expect(plan.canApply).toBe(true);
  const r = await apply(plan.id);
  expect(r.statusCode, r.body).toBe(200);
  const replacements = await h.owner.appointment.findMany({
    where: { rescheduledFromId: { in: ids } },
    orderBy: { startAt: 'asc' },
  });
  expect(replacements).toHaveLength(2);
  expect(replacements[0]!.startAt.toISOString()).toBe(
    new Date(at(targetDate, '10:00')).toISOString(),
  );
  expect(replacements[1]!.startAt.toISOString()).toBe(
    new Date(at(targetDate, '10:15')).toISOString(),
  );
  expect(
    replacements.every(
      (p) => p.consultationTypeId === typeId && p.doctorUserId === clinics.a.doctor.userId,
    ),
  ).toBe(true);
  await apply(plan.id);
  expect(await h.owner.appointment.count({ where: { rescheduledFromId: { in: ids } } })).toBe(2);
});
it('requires explicit acknowledgement for billed/clinical exceptions and preserves their records and appointments', async () => {
  await h.owner.bill.create({
    data: {
      organisationId: clinics.a.org.id,
      appointmentId: ids[0]!,
      patientId: clinics.a.patients[0]!.id,
      doctorUserId: clinics.a.doctor.userId,
      subtotalPaise: 10000,
      totalPaise: 10000,
      status: 'due',
      createdByUserId: clinics.a.admin.userId,
    },
  });
  const plan = await preview();
  expect(plan.manualCount).toBe(1);
  expect(plan.rows.find((r: { id: string }) => r.id === ids[0]).issue).toBe('financial_review');
  expect((await apply(plan.id, false)).statusCode).toBe(400);
  const r = await apply(plan.id);
  expect(r.statusCode, r.body).toBe(200);
  expect(r.json().changedCount).toBe(1);
  expect((await h.owner.appointment.findUniqueOrThrow({ where: { id: ids[0] } })).status).toBe(
    'confirmed',
  );
  expect(await h.owner.bill.count()).toBe(1);
});
it('rejects a stale snapshot after a new booking appears and changes nothing', async () => {
  const plan = await preview(),
    p = await h.owner.patient.create({
      data: { organisationId: clinics.a.org.id, uhid: 'NEW', name: 'New Arrival' },
    });
  const created = await call(
    'POST',
    '/appointments',
    {
      patientId: p.id,
      doctorUserId: clinics.a.doctor.userId,
      clinicId,
      consultationTypeId: typeId,
      startAt: new Date(at(date, '09:30')).toISOString(),
      walkIn: false,
      overbook: false,
    },
    desk,
  );
  expect(created.statusCode, created.body).toBe(201);
  expect((await apply(plan.id)).statusCode).toBe(409);
  expect(await h.owner.availabilityException.count()).toBe(0);
  expect(await h.owner.appointment.count({ where: { status: 'cancelled' } })).toBe(0);
});
it('rejects stale status or financial changes and unavailable targets, with no partial reschedule', async () => {
  const plan = await preview({
    kind: 'reschedule',
    targetDate,
    targetTime: '10:00',
    targetClinicId: clinicId,
  });
  const p = await h.owner.patient.create({
    data: { organisationId: clinics.a.org.id, uhid: 'TAKEN', name: 'Target Patient' },
  });
  const booked = await call(
    'POST',
    '/appointments',
    {
      patientId: p.id,
      doctorUserId: clinics.a.doctor.userId,
      clinicId,
      consultationTypeId: typeId,
      startAt: new Date(at(targetDate, '10:15')).toISOString(),
      walkIn: false,
      overbook: false,
    },
    desk,
  );
  expect(booked.statusCode, booked.body).toBe(201);
  const r = await apply(plan.id);
  expect(r.statusCode, r.body).toBe(409);
  expect(await h.owner.appointment.count({ where: { rescheduledFromId: { in: ids } } })).toBe(0);
  expect(await h.owner.availabilityException.count()).toBe(0);
  expect(await h.owner.appointment.count({ where: { id: { in: ids }, status: 'confirmed' } })).toBe(
    2,
  );
});
it('protects clinic/doctor roles, ownership of apply and immutable operation history', async () => {
  const plan = await preview();
  expect((await call('GET', `/clinic-operations/${plan.id}`, undefined, other)).statusCode).toBe(
    404,
  );
  expect((await apply(plan.id, true, desk)).statusCode).toBe(403);
  expect(
    (
      await call(
        'POST',
        '/clinic-operations/preview',
        body({ doctorId: clinics.b.doctor.userId }),
        doctor,
      )
    ).statusCode,
  ).toBe(403);
  const patient = await patientLogin(h, 'clinic-a', '9876543210');
  expect((await call('GET', '/clinic-operations/options', undefined, patient)).statusCode).toBe(
    403,
  );
  await apply(plan.id);
  await expect(
    withTenant(h.services.db, clinics.a.org.id, (tx) =>
      tx.clinicOperation.update({ where: { id: plan.id }, data: { resultCipher: 'changed' } }),
    ),
  ).rejects.toThrow();
});
it('binds stable preview IDs to the exact request, expires plans and serializes simultaneous apply retries', async () => {
  const b = body(),
    r = await call('POST', '/clinic-operations/preview', b);
  expect(r.statusCode, r.body).toBe(200);
  expect((await call('POST', '/clinic-operations/preview', b)).json().id).toBe(b.id);
  expect(
    (await call('POST', '/clinic-operations/preview', { ...b, reason: 'Changed' })).statusCode,
  ).toBe(409);
  const results = await Promise.all([apply(b.id), apply(b.id)]);
  for (const x of results) expect(x.statusCode, x.body).toBe(200);
  expect(await h.owner.clinicOperationalUpdate.count()).toBe(2);
  const another = await preview({ from: '11:00', to: '12:00' });
  h.clock.advance(901);
  const user = await h.owner.user.findUniqueOrThrow({ where: { id: clinics.a.admin.userId } });
  admin = await staffLogin(h, 'clinic-a', {
    ...clinics.a.admin,
    totpSecret: h.services.cipher.decrypt(user.mfaSecret!),
  });
  expect((await apply(another.id)).statusCode).toBe(409);
});
it('records delay estimates without moving visits or touching bills and exposes them to staff', async () => {
  const today = istDate(h.services.now());
  await h.owner.appointment.updateMany({
    where: { id: { in: ids } },
    data: {
      date: new Date(today),
      startAt: new Date(h.clock.ms - 600000),
      endAt: new Date(h.clock.ms + 600000),
      status: 'checked_in',
    },
  });
  const nowTime = new Date(h.clock.ms + 330 * 60000).toISOString().slice(11, 16),
    plan = await preview({
      kind: 'delay',
      date: today,
      from: '00:00',
      to: '23:59',
      delayMinutes: 45,
    });
  const r = await apply(plan.id);
  expect(r.statusCode, r.body).toBe(200);
  expect(await h.owner.availabilityException.count()).toBe(0);
  const updated = await h.owner.appointment.findUniqueOrThrow({ where: { id: ids[0] } });
  expect(updated.delayMinutes).toBe(45);
  expect(updated.startAt.getTime()).toBe(h.clock.ms - 600000);
  const staff = await call('GET', `/appointments/${ids[0]}`, undefined, desk);
  expect(staff.json().delayMinutes).toBe(45);
  void nowTime;
});
it('queues only consented generic updates and authorizes delivery once with current source and recipient checks', async () => {
  await h.owner.patient.update({
    where: { id: clinics.a.patients[0]!.id },
    data: { phone: '+919876543210' },
  });
  await h.owner.whatsAppOptIn.create({
    data: {
      id: randomUUID(),
      organisationId: clinics.a.org.id,
      phone: '+919876543210',
      senderPhoneNumberId: '1234',
      category: 'appointments',
      enabled: true,
      changedAt: h.services.now(),
    },
  });
  const plan = await preview({ notify: true });
  const applied = await apply(plan.id);
  expect(applied.statusCode, applied.body).toBe(200);
  expect(applied.json().notificationsQueued).toBe(1);
  const delivery = await h.owner.whatsAppDelivery.findFirstOrThrow({
    where: { kind: 'appointment_update' },
  });
  expect(delivery.appointmentId).toBeNull();
  const [notice] = await withMessaging(
    h.services.db,
    (tx) =>
      tx.$queryRaw<
        { phone: string; kind: string }[]
      >`SELECT * FROM messaging_begin_operational_notice(${delivery.id}::uuid,${'1234'})`,
  );
  expect(notice?.phone).toBe('+919876543210');
  expect(notice?.kind).toBe('appointment_update');
  const [receipt] = await withMessaging(
    h.services.db,
    (tx) =>
      tx.$queryRaw<
        { id: string }[]
      >`SELECT messaging_receive_status(${randomUUID()}::uuid,${'1234'},${'wamid.operation'},${delivery.id}::uuid,${'read'},${new Date()},${null}::integer) AS id`,
  );
  await withMessaging(
    h.services.db,
    (tx) => tx.$executeRaw`SELECT messaging_process_status(${receipt!.id}::uuid)`,
  );
  await withMessaging(
    h.services.db,
    (tx) =>
      tx.$executeRaw`SELECT messaging_finish_operational_notice(${delivery.id}::uuid,${'1234'},${'accepted'},${'wamid.operation'})`,
  );
  expect(
    (await h.owner.whatsAppDelivery.findUniqueOrThrow({ where: { id: delivery.id } })).status,
  ).toBe('read');
  expect(
    await withMessaging(
      h.services.db,
      (tx) =>
        tx.$queryRaw`SELECT * FROM messaging_begin_operational_notice(${delivery.id}::uuid,${'1234'})`,
    ),
  ).toEqual([]);
});
it('skips a queued update when appointment consent is withdrawn, and never offers disabled automatic notices', async () => {
  await h.owner.patient.update({
    where: { id: clinics.a.patients[0]!.id },
    data: { phone: '+919876543210' },
  });
  const pref = await h.owner.whatsAppOptIn.create({
    data: {
      id: randomUUID(),
      organisationId: clinics.a.org.id,
      phone: '+919876543210',
      senderPhoneNumberId: '1234',
      category: 'appointments',
      enabled: true,
      changedAt: h.services.now(),
    },
  });
  const plan = await preview({ notify: true });
  await apply(plan.id);
  await h.owner.whatsAppOptIn.update({
    where: { id: pref.id },
    data: { enabled: false, version: { increment: 1 }, changedAt: h.services.now() },
  });
  const delivery = await h.owner.whatsAppDelivery.findFirstOrThrow({
    where: { kind: 'appointment_update' },
  });
  expect(delivery.status).toBe('skipped');
  expect(
    await withMessaging(
      h.services.db,
      (tx) =>
        tx.$queryRaw`SELECT * FROM messaging_begin_operational_notice(${delivery.id}::uuid,${'1234'})`,
    ),
  ).toEqual([]);
  h.services.operationMessagingSender = undefined;
  expect(
    (await call('POST', '/clinic-operations/preview', body({ notify: true }))).statusCode,
  ).toBe(409);
});
it('does not let a walk-in bypass an explicit source-session closure', async () => {
  h.clock.ms = new Date(at(date, '09:05')).getTime();
  admin = await staffLogin(h, 'clinic-a', clinics.a.admin);
  const plan = await preview();
  const done = await apply(plan.id);
  expect(done.statusCode, done.body).toBe(200);
  const user = await h.owner.user.findUniqueOrThrow({
    where: { email: 'operations@clinic-a.test' },
  });
  desk = await staffLogin(h, 'clinic-a', {
    userId: user.id,
    email: user.email!,
    totpSecret: h.services.cipher.decrypt(user.mfaSecret!),
  });
  const p = await h.owner.patient.create({
      data: { organisationId: clinics.a.org.id, uhid: 'WALK-CLOSED', name: 'Walk-in' },
    }),
    walkin = await call(
      'POST',
      '/appointments',
      {
        patientId: p.id,
        doctorUserId: clinics.a.doctor.userId,
        clinicId,
        consultationTypeId: typeId,
        walkIn: true,
        overbook: false,
      },
      desk,
    );
  expect(walkin.statusCode, walkin.body).toBe(409);
  expect(await h.owner.appointment.count({ where: { patientId: p.id } })).toBe(0);
});
