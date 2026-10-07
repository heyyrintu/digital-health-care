import { AppointmentDetail, SlotsResponse, type TokenResponse } from '@dhc/contracts';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addStaff,
  bearer,
  createHarness,
  resetDatabase,
  seedTwoClinics,
  staffLogin,
} from './harness';

// The harness clock starts on Tuesday 6 Oct 2026 at 10:00 IST (04:30 UTC).
const TODAY = '2026-10-06';
const WED = '2026-10-07';
/** UTC instant of an IST wall-clock time. */
const at = (date: string, time: string) =>
  new Date(new Date(`${date}T${time}:00.000Z`).getTime() - 330 * 60_000).toISOString();

const h = createHarness();
let clinics: Awaited<ReturnType<typeof seedTwoClinics>>;
let adminA: TokenResponse;
let doctorA: TokenResponse;
let desk: TokenResponse;
let clinicId: string;
let typeId: string;
let asha: string;
let kamla: string;

beforeEach(async () => {
  // Each test starts at 10:00 IST; the clock only moves forward otherwise.
  h.clock.ms = Date.UTC(2026, 9, 6, 4, 30);
  await resetDatabase(h.owner);
  clinics = await seedTwoClinics(h);
  [asha, kamla] = clinics.a.patients.map((p) => p.id) as [string, string];
  const frontDesk = await addStaff(h, clinics.a.org.id, 'front_desk', 'desk@clinic-a.test');
  adminA = await staffLogin(h, 'clinic-a', clinics.a.admin);
  doctorA = await staffLogin(h, 'clinic-a', clinics.a.doctor);
  desk = await staffLogin(h, 'clinic-a', frontDesk);

  clinicId = (await call('POST', '/clinics', adminA, { name: 'Main clinic' })).json().id;
  typeId = (
    await call('POST', '/consultation-types', adminA, {
      name: 'In-person consultation',
      mode: 'in_person',
      defaultDurationMin: 15,
      feePaise: 80000,
    })
  ).json().id;
  const schedule = await call('POST', '/availability/versions', doctorA, {
    clinicId,
    consultationTypeId: typeId,
    effectiveFrom: TODAY,
    weekly: {
      tue: [{ start: '10:00', end: '12:00' }],
      wed: [{ start: '10:00', end: '11:00' }],
    },
  });
  expect(schedule.statusCode, schedule.body).toBe(201);
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

const book = (body: Record<string, unknown>, tokens = desk) =>
  call('POST', '/appointments', tokens, {
    patientId: asha,
    doctorUserId: clinics.a.doctor.userId,
    clinicId,
    consultationTypeId: typeId,
    ...body,
  });

async function booked(body: Record<string, unknown>, tokens = desk) {
  const res = await book(body, tokens);
  expect(res.statusCode, res.body).toBe(201);
  return AppointmentDetail.parse(res.json());
}

async function slotState(date: string, time: string) {
  const res = await call(
    'GET',
    `/slots?doctorId=${clinics.a.doctor.userId}&clinicId=${clinicId}&consultationTypeId=${typeId}&date=${date}`,
    desk,
  );
  const slot = SlotsResponse.parse(res.json()).slots.find((s) => s.startTime === time);
  return slot?.available ? 'open' : (slot?.unavailableReason ?? 'none');
}

const act = (id: string, action: string, tokens: TokenResponse, reason?: string) =>
  call('POST', `/appointments/${id}/actions`, tokens, { action, reason });

describe('booking a slot', () => {
  it('books a free slot, confirms it, gives a token and marks the slot taken', async () => {
    const appt = await booked({ startAt: at(WED, '10:00'), reason: 'Knee pain' });
    expect(appt).toMatchObject({
      status: 'confirmed',
      source: 'front_desk',
      date: WED,
      startTime: '10:00',
      tokenNumber: 1,
      overbook: false,
      reason: 'Knee pain',
      clinicName: 'Main clinic',
      consultationTypeName: 'In-person consultation',
      mode: 'in_person',
      patient: { id: asha, name: 'Asha Verma' },
    });
    expect(appt.endAt).toBe(at(WED, '10:15'));
    expect(appt.history).toMatchObject([{ fromStatus: null, toStatus: 'confirmed' }]);
    expect(await slotState(WED, '10:00')).toBe('busy');

    const second = await booked({ patientId: kamla, startAt: at(WED, '10:15') });
    expect(second.tokenNumber).toBe(2);
  });

  it('refuses taken, past and made-up times, and a second booking the same day', async () => {
    await booked({ startAt: at(WED, '10:00') });
    const taken = await book({ patientId: kamla, startAt: at(WED, '10:00') });
    expect(taken.statusCode).toBe(409);
    expect(taken.json().error.code).toBe('SLOT_TAKEN');

    expect((await book({ patientId: kamla, startAt: at(WED, '10:05') })).statusCode).toBe(409);
    // The clock is just after 10:00 today, so 10:00 has started.
    expect((await book({ patientId: kamla, startAt: at(TODAY, '10:00') })).statusCode).toBe(409);

    const twice = await book({ startAt: at(WED, '10:30') });
    expect(twice.statusCode).toBe(409);
    expect(twice.json().error.message).toContain('10:00');

    expect((await book({})).statusCode).toBe(400);
  });

  it('overbooks a taken slot within the clinic’s daily limit', async () => {
    await call('PUT', '/booking-rules', adminA, {
      horizonDays: 30,
      sameDayCutoffMinutes: 60,
      overbookPerDay: 1,
    });
    await booked({ startAt: at(WED, '10:00') });
    const extra = await booked({ patientId: kamla, startAt: at(WED, '10:00'), overbook: true });
    expect(extra).toMatchObject({ overbook: true, tokenNumber: 2 });

    const third = await registerPatient('Neha Kapoor');
    const over = await book({ patientId: third, startAt: at(WED, '10:00'), overbook: true });
    expect(over.statusCode).toBe(409);
    expect(over.json().error.code).toBe('BOOKING_LIMIT');

    // Asking to overbook a free slot is just a normal booking.
    const free = await booked({ patientId: third, startAt: at(WED, '10:15'), overbook: true });
    expect(free.overbook).toBe(false);
  });

  it('never lets two people take the same slot at once', async () => {
    const patients = [asha, kamla];
    for (let i = 0; i < 4; i++) patients.push(await registerPatient(`Synthetic ${i}`));
    const results = await Promise.all(
      patients.map((patientId) => book({ patientId, startAt: at(WED, '10:30') })),
    );
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes).toEqual([201, 409, 409, 409, 409, 409]);
  });
});

describe('walk-ins', () => {
  it('joins today’s queue checked in, with a token, without taking a slot', async () => {
    const walkIn = await booked({ walkIn: true });
    expect(walkIn).toMatchObject({
      status: 'checked_in',
      source: 'walk_in',
      date: TODAY,
      tokenNumber: 1,
    });
    expect(walkIn.checkedInAt).not.toBeNull();
    expect(await slotState(TODAY, '10:15')).toBe('open');

    expect(
      (await book({ patientId: kamla, walkIn: true, startAt: at(TODAY, '10:15') })).statusCode,
    ).toBe(400);
  });
});

describe('status changes', () => {
  it('runs check-in, consultation and completion with roles and history', async () => {
    const appt = await booked({ startAt: at(TODAY, '10:30') });
    expect((await act(appt.id, 'check_in', desk)).json().status).toBe('checked_in');
    expect((await act(appt.id, 'start', desk)).statusCode).toBe(403);

    const otherDoctor = await addStaff(h, clinics.a.org.id, 'doctor', 'doctor2@clinic-a.test');
    const other = await staffLogin(h, 'clinic-a', otherDoctor);
    expect((await act(appt.id, 'start', other)).statusCode).toBe(403);

    const started = await act(appt.id, 'start', doctorA);
    expect(started.json()).toMatchObject({ status: 'in_consultation' });
    const done = AppointmentDetail.parse((await act(appt.id, 'complete', doctorA)).json());
    expect(done.status).toBe('completed');
    expect(done.completedAt).not.toBeNull();
    expect(done.history.map((e) => e.toStatus)).toEqual([
      'confirmed',
      'checked_in',
      'in_consultation',
      'completed',
    ]);
    expect(done.history[1]?.actorUserId).not.toBe(clinics.a.doctor.userId);

    // Completed is final.
    expect((await act(appt.id, 'cancel', desk, 'Changed mind')).statusCode).toBe(409);
  });

  it('cancels with a reason and frees the slot; no-shows only after the slot starts', async () => {
    const appt = await booked({ startAt: at(WED, '10:00') });
    expect((await act(appt.id, 'cancel', desk)).statusCode).toBe(400);
    expect((await act(appt.id, 'no_show', desk)).statusCode).toBe(409);
    // Not today, so no check-in yet.
    expect((await act(appt.id, 'check_in', desk)).statusCode).toBe(409);

    const cancelled = await act(appt.id, 'cancel', desk, 'Patient travelling');
    expect(cancelled.json()).toMatchObject({
      status: 'cancelled',
      cancelReason: 'Patient travelling',
    });
    expect(await slotState(WED, '10:00')).toBe('open');

    // A no-show once the slot has started.
    const later = await booked({ patientId: kamla, startAt: at(TODAY, '10:15') });
    // Past 10:15 (access tokens last 15 minutes, so stay inside that).
    h.clock.advance(14 * 60);
    expect((await act(later.id, 'no_show', desk)).json().status).toBe('no_show');
  });
});

describe('rescheduling', () => {
  it('moves the booking to a new slot and links the two', async () => {
    const original = await booked({ startAt: at(WED, '10:00') });
    const res = await call('POST', `/appointments/${original.id}/reschedule`, desk, {
      startAt: at(WED, '10:30'),
    });
    expect(res.statusCode, res.body).toBe(201);
    const moved = AppointmentDetail.parse(res.json());
    expect(moved).toMatchObject({
      status: 'confirmed',
      startTime: '10:30',
      rescheduledFromId: original.id,
    });

    const old = AppointmentDetail.parse(
      (await call('GET', `/appointments/${original.id}`, desk)).json(),
    );
    expect(old).toMatchObject({ status: 'rescheduled', rescheduledToId: moved.id });
    expect(await slotState(WED, '10:00')).toBe('open');
    expect(await slotState(WED, '10:30')).toBe('busy');

    const again = await call('POST', `/appointments/${original.id}/reschedule`, desk, {
      startAt: at(WED, '10:45'),
    });
    expect(again.statusCode).toBe(409);
  });
});

describe('concurrent changes to one appointment', () => {
  it('lets only one of two simultaneous reschedules or status changes through', async () => {
    const appt = await booked({ startAt: at(WED, '10:00') });
    const moves = await Promise.all([
      call('POST', `/appointments/${appt.id}/reschedule`, desk, { startAt: at(WED, '10:15') }),
      call('POST', `/appointments/${appt.id}/reschedule`, doctorA, { startAt: at(WED, '10:30') }),
    ]);
    expect(moves.map((r) => r.statusCode).sort()).toEqual([201, 409]);

    const today = await booked({ patientId: kamla, startAt: at(TODAY, '10:30') });
    await act(today.id, 'check_in', desk);
    const race = await Promise.all([
      act(today.id, 'start', doctorA),
      act(today.id, 'cancel', desk, 'Left early'),
    ]);
    expect(race.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const final = AppointmentDetail.parse(
      (await call('GET', `/appointments/${today.id}`, desk)).json(),
    );
    expect(final.history).toHaveLength(3);
  });

  it('does not count a moved overbooked patient against the daily limit', async () => {
    await call('PUT', '/booking-rules', adminA, {
      horizonDays: 30,
      sameDayCutoffMinutes: 60,
      overbookPerDay: 1,
    });
    await booked({ startAt: at(WED, '10:00') });
    await booked({ patientId: kamla, startAt: at(WED, '10:15') });
    const extra = await booked({
      patientId: await registerPatient('Neha Kapoor'),
      startAt: at(WED, '10:00'),
      overbook: true,
    });
    const moved = await call('POST', `/appointments/${extra.id}/reschedule`, desk, {
      startAt: at(WED, '10:15'),
      overbook: true,
    });
    expect(moved.statusCode, moved.body).toBe(201);
    expect(moved.json().overbook).toBe(true);
  });
});

describe('lists and tenant isolation', () => {
  it('lists a day (today by default) and a patient’s appointments', async () => {
    await booked({ startAt: at(TODAY, '11:00') });
    await booked({ patientId: kamla, startAt: at(TODAY, '10:30') });
    await booked({ startAt: at(WED, '10:00') });

    const today = await call('GET', '/appointments', desk);
    expect(today.json().data.map((a: { startTime: string }) => a.startTime)).toEqual([
      '10:30',
      '11:00',
    ]);
    const wed = await call('GET', `/appointments?date=${WED}`, doctorA);
    expect(wed.json().data).toHaveLength(1);
    const mine = await call('GET', `/appointments?patientId=${asha}`, desk);
    expect(mine.json().data.map((a: { date: string }) => a.date)).toEqual([WED, TODAY]);
  });

  it('keeps each organisation’s appointments to itself', async () => {
    const appt = await booked({ startAt: at(WED, '10:00') });
    const adminB = await staffLogin(h, 'clinic-b', clinics.b.admin);
    expect((await call('GET', '/appointments', adminB)).json().data).toEqual([]);
    expect((await call('GET', `/appointments/${appt.id}`, adminB)).statusCode).toBe(404);
    expect((await act(appt.id, 'cancel', adminB, 'Sneaky')).statusCode).toBe(404);

    const borrowed = await call('POST', '/appointments', adminB, {
      patientId: asha,
      doctorUserId: clinics.a.doctor.userId,
      clinicId,
      consultationTypeId: typeId,
      startAt: at(WED, '10:15'),
    });
    expect(borrowed.statusCode).toBe(400);
  });

  it('audits bookings and changes without patient details', async () => {
    const appt = await booked({ startAt: at(WED, '10:00'), reason: 'Back pain' });
    await act(appt.id, 'cancel', desk, 'Feeling better');
    const audit = await h.owner.auditLog.findMany({
      where: { action: { startsWith: 'appointment.' } },
    });
    expect(audit.map((a) => a.action).sort()).toEqual([
      'appointment.created',
      'appointment.status_changed',
    ]);
    const text = JSON.stringify(audit.map((a) => a.metadata));
    expect(text).not.toContain('Back pain');
    expect(text).not.toContain('Feeling better');
    expect(text).not.toContain('Asha');
  });
});

async function registerPatient(name: string) {
  const patient = await h.owner.patient.create({
    data: {
      organisationId: clinics.a.org.id,
      uhid: `T-${Math.random().toString(36).slice(2, 8)}`,
      name,
    },
  });
  return patient.id;
}
