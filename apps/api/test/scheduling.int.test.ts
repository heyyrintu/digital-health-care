import {
  AvailabilityVersion,
  ConsultationType,
  SlotsResponse,
  type TokenResponse,
} from '@dhc/contracts';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addStaff,
  bearer,
  createHarness,
  resetDatabase,
  seedTwoClinics,
  staffLogin,
} from './harness';

// The harness clock starts on Tuesday 6 Oct 2026 at 10:00 IST.
const TODAY = '2026-10-06';
const WED = '2026-10-07';
const THU = '2026-10-08';

const h = createHarness();
let clinics: Awaited<ReturnType<typeof seedTwoClinics>>;
let adminA: TokenResponse;
let doctorA: TokenResponse;
let desk: TokenResponse;
let clinicId: string;
let typeId: string;

beforeEach(async () => {
  await resetDatabase(h.owner);
  clinics = await seedTwoClinics(h);
  const frontDesk = await addStaff(h, clinics.a.org.id, 'front_desk', 'desk@clinic-a.test');
  adminA = await staffLogin(h, 'clinic-a', clinics.a.admin);
  doctorA = await staffLogin(h, 'clinic-a', clinics.a.doctor);
  desk = await staffLogin(h, 'clinic-a', frontDesk);

  const clinic = await call('POST', '/clinics', adminA, { name: 'Main clinic' });
  expect(clinic.statusCode, clinic.body).toBe(201);
  clinicId = clinic.json().id;
  const type = await call('POST', '/consultation-types', adminA, {
    name: 'In-person consultation',
    mode: 'in_person',
    defaultDurationMin: 15,
    feePaise: 80000,
    followUpFeePaise: 50000,
  });
  expect(type.statusCode, type.body).toBe(201);
  typeId = type.json().id;
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

const weekly = {
  tue: [{ start: '10:00', end: '11:00' }],
  wed: [
    { start: '10:00', end: '11:00' },
    { start: '17:00', end: '17:30' },
  ],
};

async function setSchedule(tokens: TokenResponse, body: Record<string, unknown> = {}) {
  const res = await call('POST', '/availability/versions', tokens, {
    clinicId,
    consultationTypeId: typeId,
    effectiveFrom: TODAY,
    weekly,
    ...body,
  });
  expect(res.statusCode, res.body).toBe(201);
  return AvailabilityVersion.parse(res.json());
}

async function slots(date: string, channel = 'staff', tokens = desk) {
  const doctorId = clinics.a.doctor.userId;
  const res = await call(
    'GET',
    `/slots?doctorId=${doctorId}&clinicId=${clinicId}&consultationTypeId=${typeId}&date=${date}&channel=${channel}`,
    tokens,
  );
  expect(res.statusCode, res.body).toBe(200);
  return SlotsResponse.parse(res.json());
}

const times = (day: SlotsResponse) => day.slots.map((s) => s.startTime);

describe('clinic setup', () => {
  it('lets a clinic admin add clinics and consultation types, and staff read them', async () => {
    const types = await call('GET', '/consultation-types', desk);
    expect(types.json().data).toEqual([
      ConsultationType.parse({
        id: typeId,
        name: 'In-person consultation',
        mode: 'in_person',
        defaultDurationMin: 15,
        feePaise: 80000,
        followUpFeePaise: 50000,
        requiresPrepayment: false,
        active: true,
      }),
    ]);
    const dup = await call('POST', '/clinics', adminA, { name: 'Main clinic' });
    expect(dup.statusCode).toBe(409);

    const renamed = await call('PATCH', `/clinics/${clinicId}`, adminA, {
      address: '1 Synthetic Marg, Delhi',
    });
    expect(renamed.json()).toMatchObject({
      name: 'Main clinic',
      address: '1 Synthetic Marg, Delhi',
    });

    expect((await call('POST', '/clinics', desk, { name: 'Branch' })).statusCode).toBe(403);
    expect((await call('GET', '/clinics', desk)).json().data).toHaveLength(1);

    const doctors = await call('GET', '/doctors', desk);
    expect(doctors.json().data).toEqual([{ userId: clinics.a.doctor.userId, displayName: null }]);
  });

  it('uses the default booking rules until an admin changes them', async () => {
    expect((await call('GET', '/booking-rules', desk)).json()).toEqual({
      horizonDays: 30,
      sameDayCutoffMinutes: 60,
    });
    const put = await call('PUT', '/booking-rules', adminA, {
      horizonDays: 14,
      sameDayCutoffMinutes: 120,
    });
    expect(put.statusCode).toBe(200);
    expect((await call('GET', '/booking-rules', desk)).json().horizonDays).toBe(14);
    expect(
      (await call('PUT', '/booking-rules', adminA, { horizonDays: 0, sameDayCutoffMinutes: 0 }))
        .statusCode,
    ).toBe(400);
  });
});

describe('weekly schedules', () => {
  it('lets a doctor set their own schedule and turns it into slots', async () => {
    const version = await setSchedule(doctorA);
    expect(version).toMatchObject({
      doctorUserId: clinics.a.doctor.userId,
      slotMinutes: 15,
      bufferMinutes: 0,
      effectiveFrom: TODAY,
    });

    expect(times(await slots(WED))).toEqual(['10:00', '10:15', '10:30', '10:45', '17:00', '17:15']);
    expect((await slots(THU)).closed).toBe('no_schedule');

    // Today: 10:00 has begun (the clock is a little after 10:00 IST).
    const today = await slots(TODAY);
    expect(today.slots[0]).toMatchObject({ startTime: '10:00', unavailableReason: 'past' });
    expect(today.slots[1]?.available).toBe(true);
  });

  it('rejects overlapping sessions, past start dates and a second version on the same day', async () => {
    const overlap = await call('POST', '/availability/versions', doctorA, {
      clinicId,
      consultationTypeId: typeId,
      effectiveFrom: TODAY,
      weekly: {
        mon: [
          { start: '10:00', end: '12:00' },
          { start: '11:00', end: '13:00' },
        ],
      },
    });
    expect(overlap.statusCode).toBe(400);
    expect(overlap.json().error.fields).toEqual({ 'weekly.mon': 'Sessions overlap.' });

    const past = await call('POST', '/availability/versions', doctorA, {
      clinicId,
      consultationTypeId: typeId,
      effectiveFrom: '2026-10-05',
      weekly,
    });
    expect(past.statusCode).toBe(400);

    await setSchedule(doctorA);
    const again = await call('POST', '/availability/versions', doctorA, {
      clinicId,
      consultationTypeId: typeId,
      effectiveFrom: TODAY,
      weekly,
    });
    expect(again.statusCode).toBe(409);
  });

  it('only lets doctors change their own schedule; admins choose the doctor', async () => {
    const otherDoctor = await addStaff(h, clinics.a.org.id, 'doctor', 'doctor2@clinic-a.test');
    const forOther = await call('POST', '/availability/versions', doctorA, {
      doctorUserId: otherDoctor.userId,
      clinicId,
      consultationTypeId: typeId,
      effectiveFrom: TODAY,
      weekly,
    });
    expect(forOther.statusCode).toBe(403);

    const noDoctor = await call('POST', '/availability/versions', adminA, {
      clinicId,
      consultationTypeId: typeId,
      effectiveFrom: TODAY,
      weekly,
    });
    expect(noDoctor.statusCode).toBe(400);

    const byAdmin = await setSchedule(adminA, { doctorUserId: otherDoctor.userId });
    expect(byAdmin.doctorUserId).toBe(otherDoctor.userId);

    const byDesk = await call('POST', '/availability/versions', desk, {
      doctorUserId: clinics.a.doctor.userId,
      clinicId,
      consultationTypeId: typeId,
      effectiveFrom: TODAY,
      weekly,
    });
    expect(byDesk.statusCode).toBe(403);
  });

  it('applies a later version from its date without changing earlier days', async () => {
    await setSchedule(doctorA);
    const later = await setSchedule(doctorA, {
      effectiveFrom: '2026-10-14',
      slotMinutes: 30,
      bufferMinutes: 0,
    });
    expect(times(await slots(WED))).toHaveLength(6);
    expect(times(await slots('2026-10-14'))).toEqual(['10:00', '10:30', '17:00']);

    const list = await call(
      'GET',
      `/availability/versions?doctorId=${clinics.a.doctor.userId}`,
      desk,
    );
    expect(list.json().data.map((v: { effectiveFrom: string }) => v.effectiveFrom)).toEqual([
      '2026-10-14',
      TODAY,
    ]);

    // A version that has not started can be withdrawn; one already in force cannot.
    expect((await call('DELETE', `/availability/versions/${later.id}`, doctorA)).statusCode).toBe(
      204,
    );
    const current = list.json().data[1].id;
    expect((await call('DELETE', `/availability/versions/${current}`, doctorA)).statusCode).toBe(
      409,
    );
    expect(times(await slots('2026-10-14'))).toHaveLength(6);

    const audit = await h.owner.auditLog.findMany({
      where: { action: { startsWith: 'availability.' } },
    });
    expect(audit.map((a) => a.action).sort()).toEqual([
      'availability.version_created',
      'availability.version_created',
      'availability.version_deleted',
    ]);
    expect(audit.every((a) => a.actorUserId === clinics.a.doctor.userId)).toBe(true);
  });
});

describe('leave, holidays and extra sessions', () => {
  beforeEach(async () => {
    await setSchedule(doctorA);
  });

  it('closes days for leave and holidays, and part of a day for part-day leave', async () => {
    const leave = await call('POST', '/availability/exceptions', doctorA, {
      type: 'leave',
      startDate: WED,
      endDate: WED,
      startTime: '10:20',
      endTime: '11:00',
      reason: 'Conference',
    });
    expect(leave.statusCode, leave.body).toBe(201);
    expect(leave.json()).toMatchObject({ doctorUserId: clinics.a.doctor.userId, clinicId: null });
    expect(times(await slots(WED))).toEqual(['10:00', '17:00', '17:15']);

    const holiday = await call('POST', '/availability/exceptions', adminA, {
      type: 'holiday',
      clinicId,
      startDate: '2026-10-20',
      endDate: '2026-10-21',
      reason: 'Dussehra',
    });
    expect(holiday.statusCode).toBe(201);
    expect((await slots('2026-10-20')).closed).toBe('holiday');
    expect((await slots('2026-10-21')).closed).toBe('holiday');

    // Doctors cannot declare clinic holidays; front desk cannot add leave.
    expect(
      (
        await call('POST', '/availability/exceptions', doctorA, {
          type: 'holiday',
          startDate: WED,
          endDate: WED,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await call('POST', '/availability/exceptions', desk, {
          type: 'leave',
          startDate: WED,
          endDate: WED,
        })
      ).statusCode,
    ).toBe(403);

    const list = await call(
      'GET',
      `/availability/exceptions?doctorId=${clinics.a.doctor.userId}`,
      desk,
    );
    expect(list.json().data.map((e: { type: string }) => e.type)).toEqual(['leave', 'holiday']);
  });

  it('adds slots for an extra session, using the type’s duration on an unscheduled day', async () => {
    const extra = await call('POST', '/availability/exceptions', doctorA, {
      type: 'extra_session',
      clinicId,
      consultationTypeId: typeId,
      startDate: THU,
      endDate: THU,
      startTime: '18:00',
      endTime: '18:45',
    });
    expect(extra.statusCode, extra.body).toBe(201);
    expect(times(await slots(THU))).toEqual(['18:00', '18:15', '18:30']);

    const missingHours = await call('POST', '/availability/exceptions', doctorA, {
      type: 'extra_session',
      clinicId,
      consultationTypeId: typeId,
      startDate: THU,
      endDate: THU,
    });
    expect(missingHours.statusCode).toBe(400);

    // Removable until it starts.
    const removed = await call('DELETE', `/availability/exceptions/${extra.json().id}`, doctorA);
    expect(removed.statusCode).toBe(204);
    expect((await slots(THU)).closed).toBe('no_schedule');
  });

  it('rejects past dates, reversed ranges and half-given times', async () => {
    const cases = [
      { startDate: '2026-10-05', endDate: '2026-10-05' },
      { startDate: THU, endDate: WED },
      { startDate: WED, endDate: WED, startTime: '10:00' },
      { startDate: WED, endDate: WED, startTime: '11:00', endTime: '10:00' },
    ];
    for (const c of cases) {
      const res = await call('POST', '/availability/exceptions', doctorA, { type: 'leave', ...c });
      expect(res.statusCode, JSON.stringify(c)).toBe(400);
    }
  });
});

describe('the patient booking window', () => {
  beforeEach(async () => {
    await setSchedule(doctorA);
  });

  it('applies the horizon and same-day cutoff to patients but not to staff', async () => {
    // At 10:00 IST with a 60-minute cutoff, the rest of the morning is closed to patients.
    const patientToday = await slots(TODAY, 'patient');
    expect(patientToday.slots.filter((s) => s.available)).toEqual([]);
    expect(patientToday.slots[1]?.unavailableReason).toBe('cutoff');
    expect((await slots(TODAY)).slots[1]?.available).toBe(true);

    const farTuesday = '2026-11-10';
    expect((await slots(farTuesday, 'patient')).closed).toBe('beyond_horizon');
    expect(times(await slots(farTuesday))).toHaveLength(4);
  });
});

describe('tenant isolation', () => {
  it('never lets another organisation use or read this clinic’s setup', async () => {
    const adminB = await staffLogin(h, 'clinic-b', clinics.b.admin);
    const doctorB = await staffLogin(h, 'clinic-b', clinics.b.doctor);

    expect((await call('GET', '/clinics', adminB)).json().data).toEqual([]);
    expect(
      (await call('PATCH', `/clinics/${clinicId}`, adminB, { name: 'Taken over' })).statusCode,
    ).toBe(404);

    const borrowed = await call('POST', '/availability/versions', doctorB, {
      clinicId,
      consultationTypeId: typeId,
      effectiveFrom: TODAY,
      weekly,
    });
    expect(borrowed.statusCode).toBe(400);

    const peek = await call(
      'GET',
      `/slots?doctorId=${clinics.a.doctor.userId}&clinicId=${clinicId}&consultationTypeId=${typeId}&date=${WED}`,
      adminB,
    );
    expect(peek.statusCode).toBe(404);

    // Clinic A's doctor is not a doctor in clinic B.
    const clinicB = await call('POST', '/clinics', adminB, { name: 'B clinic' });
    const typeB = await call('POST', '/consultation-types', adminB, {
      name: 'Video',
      mode: 'video',
      defaultDurationMin: 20,
      feePaise: 60000,
    });
    const foreignDoctor = await call('POST', '/availability/versions', adminB, {
      doctorUserId: clinics.a.doctor.userId,
      clinicId: clinicB.json().id,
      consultationTypeId: typeB.json().id,
      effectiveFrom: TODAY,
      weekly,
    });
    expect(foreignDoctor.statusCode).toBe(400);
  });
});
