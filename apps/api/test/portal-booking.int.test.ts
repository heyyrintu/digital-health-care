import { createHash } from 'node:crypto';
import {
  BookingOptions,
  CURRENT_CONSENT_VERSIONS,
  PortalAppointment,
  PortalAppointmentList,
  PortalPrescriptionList,
  SlotsResponse,
  type TokenResponse,
} from '@dhc/contracts';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addStaff,
  bearer,
  createHarness,
  patientLogin,
  resetDatabase,
  seedTwoClinics,
  staffLogin,
} from './harness';

// The harness clock starts on Tuesday 6 Oct 2026 at 10:00 IST (04:30 UTC).
const TODAY = '2026-10-06';
const WED = '2026-10-07';
const at = (date: string, time: string) =>
  new Date(new Date(`${date}T${time}:00.000Z`).getTime() - 330 * 60_000).toISOString();

const h = createHarness();
let clinics: Awaited<ReturnType<typeof seedTwoClinics>>;
let adminA: TokenResponse;
let desk: TokenResponse;
let patient: TokenResponse;
let clinicId: string;
let typeId: string;
let neha: string;
let child: string;
let stranger: string;

const call = (method: string, url: string, tokens: TokenResponse, payload?: unknown) =>
  h.app.inject({
    method: method as 'GET',
    url: `/v1${url}`,
    headers: bearer(tokens),
    payload: payload as object,
  });

const ALL = Object.entries(CURRENT_CONSENT_VERSIONS).map(([kind, version]) => ({ kind, version }));

beforeEach(async () => {
  h.clock.ms = Date.UTC(2026, 9, 6, 4, 30);
  await resetDatabase(h.owner);
  clinics = await seedTwoClinics(h);
  const frontDesk = await addStaff(h, clinics.a.org.id, 'front_desk', 'desk@clinic-a.test');
  adminA = await staffLogin(h, 'clinic-a', clinics.a.admin);
  const doctorA = await staffLogin(h, 'clinic-a', clinics.a.doctor);
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
  await call('POST', '/consultation-types', adminA, {
    name: 'Video consultation',
    mode: 'video',
    defaultDurationMin: 15,
    feePaise: 60000,
  });
  const schedule = await call('POST', '/availability/versions', doctorA, {
    clinicId,
    consultationTypeId: typeId,
    effectiveFrom: TODAY,
    weekly: {
      tue: [{ start: '10:00', end: '12:00' }],
      wed: [{ start: '10:00', end: '12:00' }],
    },
  });
  expect(schedule.statusCode, schedule.body).toBe(201);

  const register = async (payload: Record<string, unknown>) =>
    (await call('POST', '/patients', desk, payload)).json().id as string;
  neha = await register({ name: 'Neha Kapoor', phone: '9876543210' });
  child = await register({ name: 'Aarav Kapoor', guardianPatientId: neha });
  stranger = await register({ name: 'Someone Else', phone: '9000000001' });

  patient = await patientLogin(h, 'clinic-a', '9876543210');
  await call('POST', '/portal/consents', patient, { accept: ALL });
});

afterAll(async () => {
  await h.app.close();
  await h.owner.$disconnect();
});

const bookAs = (body: Record<string, unknown>, tokens = patient) =>
  call('POST', '/portal/appointments', tokens, {
    patientId: neha,
    doctorUserId: clinics.a.doctor.userId,
    clinicId,
    consultationTypeId: typeId,
    ...body,
  });

describe('booking options and slots', () => {
  it('offers in-person consultations without prepayment, and the doctors', async () => {
    const options = BookingOptions.parse(
      (await call('GET', '/portal/booking-options', patient)).json(),
    );
    expect(options.consultationTypes.map((t) => t.name)).toEqual(['In-person consultation']);
    expect(options.doctors.map((d) => d.userId)).toEqual([clinics.a.doctor.userId]);
    expect(options).toMatchObject({ horizonDays: 30, cancelCutoffMinutes: 120 });
  });

  it('applies the same-day cutoff and the horizon', async () => {
    const q = `doctorId=${clinics.a.doctor.userId}&clinicId=${clinicId}&consultationTypeId=${typeId}`;
    const today = SlotsResponse.parse(
      (await call('GET', `/portal/slots?${q}&date=${TODAY}`, patient)).json(),
    );
    // 10:00 now, 60-minute cutoff: the next hour is closed to patients, later slots are open.
    const state = (time: string) => today.slots.find((s) => s.startTime === time);
    expect(state('10:30')?.unavailableReason).toBe('cutoff');
    expect(state('11:30')?.available).toBe(true);
    const far = SlotsResponse.parse(
      (await call('GET', `/portal/slots?${q}&date=2026-12-30`, patient)).json(),
    );
    expect(far.closed).toBe('beyond_horizon');
  });
});

describe('booking', () => {
  it('books the account’s patients into open slots, confirmed, from the app', async () => {
    const res = await bookAs({ startAt: at(WED, '10:00'), reason: 'Fever' });
    expect(res.statusCode, res.body).toBe(201);
    const appt = PortalAppointment.parse(res.json());
    expect(appt).toMatchObject({
      status: 'confirmed',
      date: WED,
      startTime: '10:00',
      tokenNumber: 1,
      canCancel: true,
      patient: { id: neha },
    });
    const row = await h.owner.appointment.findUniqueOrThrow({ where: { id: appt.id } });
    expect(row.source).toBe('app');

    const forChild = await bookAs({ patientId: child, startAt: at(WED, '10:15') });
    expect(forChild.statusCode, forChild.body).toBe(201);

    // The front desk sees it in the clinic's list like any booking.
    const list = await call('GET', `/appointments?date=${WED}`, desk);
    expect(list.json().data.map((a: { id: string }) => a.id)).toContain(appt.id);
  });

  it('waits for the front desk when the clinic confirms bookings itself', async () => {
    const rules = (await call('GET', '/booking-rules', adminA)).json();
    await call('PUT', '/booking-rules', adminA, { ...rules, autoConfirm: false });
    const res = await bookAs({ startAt: at(WED, '10:00') });
    expect(res.json().status).toBe('pending');
  });

  it('refuses other people’s patients, taken slots, the cutoff and online consultations', async () => {
    expect((await bookAs({ patientId: stranger, startAt: at(WED, '10:00') })).statusCode).toBe(404);

    await call('POST', '/appointments', desk, {
      patientId: stranger,
      doctorUserId: clinics.a.doctor.userId,
      clinicId,
      consultationTypeId: typeId,
      startAt: at(WED, '10:30'),
    });
    expect((await bookAs({ startAt: at(WED, '10:30') })).json().error.code).toBe('SLOT_TAKEN');

    const soon = await bookAs({ startAt: at(TODAY, '10:30') });
    expect(soon.statusCode).toBe(409);
    expect(soon.json().error.fields).toEqual({ startAt: 'cutoff' });

    const video = (await h.owner.consultationType.findFirstOrThrow({ where: { mode: 'video' } }))
      .id;
    expect(
      (await bookAs({ consultationTypeId: video, startAt: at(WED, '11:00') })).statusCode,
    ).toBe(400);
  });

  it('limits upcoming bookings per patient', async () => {
    expect((await bookAs({ startAt: at(WED, '10:00') })).statusCode).toBe(201);
    expect((await bookAs({ startAt: at(TODAY, '11:30') })).statusCode).toBe(201);
    const third = await bookAs({ startAt: at('2026-10-13', '10:00') });
    expect(third.statusCode).toBe(409);
    expect(third.json().error).toMatchObject({
      code: 'BOOKING_LIMIT',
      fields: { reason: 'active_bookings' },
    });
  });

  it('pauses online booking after repeated no-shows', async () => {
    for (const time of ['10:00', '10:15', '10:30']) {
      await h.owner.appointment.create({
        data: {
          organisationId: clinics.a.org.id,
          patientId: neha,
          doctorUserId: clinics.a.doctor.userId,
          clinicId,
          consultationTypeId: typeId,
          date: new Date('2026-09-29T00:00:00Z'),
          startAt: new Date(at('2026-09-29', time)),
          endAt: new Date(new Date(at('2026-09-29', time)).getTime() + 15 * 60_000),
          status: 'no_show',
          source: 'front_desk',
          tokenNumber: Number(time.slice(3)) + 1,
          createdByUserId: clinics.a.admin.userId,
        },
      });
    }
    const res = await bookAs({ startAt: at(WED, '10:00') });
    expect(res.json().error).toMatchObject({
      code: 'BOOKING_LIMIT',
      fields: { reason: 'no_shows' },
    });
  });

  it('needs the onboarding consents', async () => {
    await call('POST', '/portal/consents/health_data/withdraw', patient);
    expect((await bookAs({ startAt: at(WED, '10:00') })).json().error.code).toBe(
      'CONSENT_REQUIRED',
    );
    expect((await call('GET', '/portal/appointments', patient)).statusCode).toBe(403);
  });
});

describe('appointments and cancelling', () => {
  it('lists the family’s visits, upcoming then past, and cancels before the cutoff', async () => {
    const mine = PortalAppointment.parse((await bookAs({ startAt: at(WED, '10:00') })).json());
    await bookAs({ patientId: child, startAt: at(TODAY, '11:30') });
    await call('POST', '/appointments', desk, {
      patientId: stranger,
      doctorUserId: clinics.a.doctor.userId,
      clinicId,
      consultationTypeId: typeId,
      startAt: at(WED, '11:00'),
    });

    const list = PortalAppointmentList.parse(
      (await call('GET', '/portal/appointments', patient)).json(),
    );
    expect(list.upcoming.map((a) => [a.patient.id, a.startTime])).toEqual([
      [child, '11:30'],
      [neha, '10:00'],
    ]);
    expect(list.past).toEqual([]);

    const cancelled = await call('POST', `/portal/appointments/${mine.id}/cancel`, patient, {
      reason: 'Feeling better',
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(cancelled.json()).toMatchObject({ status: 'cancelled', canCancel: false });
    const after = PortalAppointmentList.parse(
      (await call('GET', '/portal/appointments', patient)).json(),
    );
    expect(after.past.map((a) => a.id)).toEqual([mine.id]);

    const history = await h.owner.appointmentStatusHistory.findMany({
      where: { appointmentId: mine.id, toStatus: 'cancelled' },
    });
    expect(history[0]?.note).toBe('Feeling better');
  });

  it('refuses to cancel inside the cutoff or someone else’s visit', async () => {
    const soon = PortalAppointment.parse((await bookAs({ startAt: at(TODAY, '11:30') })).json());
    expect(soon.canCancel).toBe(false);
    const late = await call('POST', `/portal/appointments/${soon.id}/cancel`, patient, {});
    expect(late.json().error.fields).toEqual({ reason: 'cutoff' });

    const theirs = (
      await call('POST', '/appointments', desk, {
        patientId: stranger,
        doctorUserId: clinics.a.doctor.userId,
        clinicId,
        consultationTypeId: typeId,
        startAt: at(WED, '11:00'),
      })
    ).json().id;
    expect(
      (await call('POST', `/portal/appointments/${theirs}/cancel`, patient, {})).statusCode,
    ).toBe(404);
  });
});

describe('prescriptions', () => {
  let token = 0;
  async function signedFor(patientId: string, number: string) {
    const appt = await h.owner.appointment.create({
      data: {
        organisationId: clinics.a.org.id,
        patientId,
        doctorUserId: clinics.a.doctor.userId,
        clinicId,
        consultationTypeId: typeId,
        date: new Date('2026-10-01T00:00:00Z'),
        startAt: new Date(at('2026-10-01', '10:00')),
        endAt: new Date(at('2026-10-01', '10:15')),
        status: 'completed',
        source: 'front_desk',
        tokenNumber: ++token,
        createdByUserId: clinics.a.admin.userId,
      },
    });
    const pdf = Buffer.from(`%PDF-1.4 synthetic ${number}`);
    const key = `test/${number.toLowerCase()}.pdf`;
    await h.services.files.put(key, pdf);
    return h.owner.prescription.create({
      data: {
        organisationId: clinics.a.org.id,
        appointmentId: appt.id,
        patientId,
        doctorUserId: clinics.a.doctor.userId,
        status: 'signed',
        number,
        signedAt: new Date(at('2026-10-01', '10:20')),
        pdfFileKey: key,
        pdfSha256: createHash('sha256').update(pdf).digest('hex'),
        templateVersion: 'test',
        paperSize: 'a4',
        signatureMethod: 'test_key',
        signature: 'synthetic',
        verificationCode: `code-${number}`,
      },
    });
  }

  it('lists the family’s signed prescriptions and opens their PDFs, never others’', async () => {
    const own = await signedFor(child, 'RX-1');
    const theirs = await signedFor(stranger, 'RX-2');

    const list = PortalPrescriptionList.parse(
      (await call('GET', '/portal/prescriptions', patient)).json(),
    );
    expect(list.data).toEqual([
      expect.objectContaining({
        id: own.id,
        number: 'RX-1',
        status: 'signed',
        date: '2026-10-01',
        patient: { id: child, name: 'Aarav Kapoor' },
      }),
    ]);

    const pdf = await call('GET', `/portal/prescriptions/${own.id}/pdf`, patient);
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.body).toContain('RX-1');
    expect((await call('GET', `/portal/prescriptions/${theirs.id}/pdf`, patient)).statusCode).toBe(
      404,
    );
    const audit = await h.owner.auditLog.findFirst({
      where: { action: 'prescription.pdf_viewed' },
    });
    expect(audit?.entityId).toBe(own.id);
  });
});
