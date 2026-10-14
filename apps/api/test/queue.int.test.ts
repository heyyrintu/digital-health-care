import {
  CreatedDisplayScreen,
  DisplayBoard,
  QueueResponse,
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

// Tuesday 6 Oct 2026, 10:00 IST.
const TODAY = '2026-10-06';
const at = (date: string, time: string) =>
  new Date(new Date(`${date}T${time}:00.000Z`).getTime() - 330 * 60_000).toISOString();

const h = createHarness();
let clinics: Awaited<ReturnType<typeof seedTwoClinics>>;
let adminA: TokenResponse;
let doctorA: TokenResponse;
let desk: TokenResponse;
let clinicId: string;
let typeId: string;

beforeEach(async () => {
  h.clock.ms = Date.UTC(2026, 9, 6, 4, 30);
  await resetDatabase(h.owner);
  clinics = await seedTwoClinics(h);
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
  await call('POST', '/availability/versions', doctorA, {
    clinicId,
    consultationTypeId: typeId,
    effectiveFrom: TODAY,
    weekly: { tue: [{ start: '10:00', end: '13:00' }] },
  });
});

afterAll(async () => {
  await h.app.close();
  await h.owner.$disconnect();
});

const call = (method: string, url: string, tokens: TokenResponse | null, payload?: unknown) =>
  h.app.inject({
    method: method as 'GET',
    url: `/v1${url}`,
    headers: tokens ? bearer(tokens) : {},
    payload: payload as object,
  });

async function book(patientId: string, body: Record<string, unknown>) {
  const res = await call('POST', '/appointments', desk, {
    patientId,
    doctorUserId: clinics.a.doctor.userId,
    clinicId,
    consultationTypeId: typeId,
    ...body,
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string; tokenNumber: number };
}

const act = (id: string, action: string, tokens: TokenResponse, reason?: string) =>
  call('POST', `/appointments/${id}/actions`, tokens, { action, reason });

async function patient(name: string, sortToTop = false) {
  const p = await h.owner.patient.create({
    data: { organisationId: clinics.a.org.id, uhid: `Q-${name.split(' ')[0]}`, name },
  });
  if (sortToTop) {
    const tag = await h.owner.tag.create({
      data: {
        organisationId: clinics.a.org.id,
        name: 'Emergency',
        colour: '#b91c1c',
        sortToTop: true,
      },
    });
    await h.owner.patientTag.create({
      data: {
        organisationId: clinics.a.org.id,
        patientId: p.id,
        tagId: tag.id,
        addedByUserId: clinics.a.doctor.userId,
      },
    });
  }
  return p.id;
}

async function queue(tokens = desk) {
  const res = await call('GET', '/queue', tokens);
  expect(res.statusCode, res.body).toBe(200);
  return QueueResponse.parse(res.json());
}

const names = (list: QueueResponse['myOpd']) => list.map((a) => a.patient.name);

describe('the queue', () => {
  it('orders My OPD: in consultation, then priority patients, then arrival order', async () => {
    const [asha, kamla] = clinics.a.patients.map((p) => p.id) as [string, string];
    await book(asha, { startAt: at(TODAY, '11:00') });
    const booked = await book(kamla, { startAt: at(TODAY, '11:30') });

    const first = await book(await patient('Ravi Walkin'), { walkIn: true });
    h.clock.advance(60);
    await book(await patient('Neha Urgent', true), { walkIn: true });
    h.clock.advance(60);
    await act(booked.id, 'check_in', desk);

    let q = await queue();
    expect(names(q.myOpd)).toEqual(['Neha Urgent', 'Ravi Walkin', 'Kamla Devi']);
    expect(names(q.booked)).toEqual(['Asha Verma']);

    await act(first.id, 'start', doctorA);
    q = await queue();
    expect(names(q.myOpd)).toEqual(['Ravi Walkin', 'Neha Urgent', 'Kamla Devi']);
    expect(q.myOpd[0]?.status).toBe('in_consultation');

    h.clock.advance(6 * 60);
    await act(first.id, 'complete', doctorA);
    await act(booked.id, 'cancel', desk, 'Left');
    q = await queue();
    expect(names(q.completed)).toEqual(['Ravi Walkin']);
    expect(names(q.closed)).toEqual(['Kamla Devi']);
    expect(q.averageConsultationMinutes).toBe(6);
  });

  it('filters by doctor and keeps other organisations out', async () => {
    await book(clinics.a.patients[0]!.id, { walkIn: true });
    const other = await addStaff(h, clinics.a.org.id, 'doctor', 'doctor2@clinic-a.test');
    const res = await call('GET', `/queue?doctorId=${other.userId}`, desk);
    expect(QueueResponse.parse(res.json()).myOpd).toEqual([]);

    const adminB = await staffLogin(h, 'clinic-b', clinics.b.admin);
    expect((await queue(adminB)).myOpd).toEqual([]);
    expect((await call('GET', '/queue', null)).statusCode).toBe(401);
  });
});

describe('waiting-room screens', () => {
  it('shows the token being seen and the next ones, without names, until revoked', async () => {
    expect(
      (await call('POST', '/display-screens', desk, { clinicId, label: 'Reception TV' }))
        .statusCode,
    ).toBe(403);
    const res = await call('POST', '/display-screens', adminA, { clinicId, label: 'Reception TV' });
    expect(res.statusCode, res.body).toBe(201);
    const screen = CreatedDisplayScreen.parse(res.json());
    expect(screen.link).toMatch(/^https:\/\/app\.test\/display#[\w-]{40,}$/);
    const token = screen.link.split('#')[1]!;

    const empty = await call('POST', '/display/board', null, { token });
    expect(DisplayBoard.parse(empty.json())).toEqual({
      clinicName: 'Main clinic',
      date: TODAY,
      doctors: [],
    });

    const a = await book(clinics.a.patients[0]!.id, { walkIn: true });
    h.clock.advance(60);
    const b = await book(clinics.a.patients[1]!.id, { walkIn: true });
    await act(a.id, 'start', doctorA);
    const board = await call('POST', '/display/board', null, { token });
    expect(board.statusCode).toBe(200);
    expect(DisplayBoard.parse(board.json()).doctors).toEqual([
      { doctorName: null, nowServing: a.tokenNumber, next: [b.tokenNumber] },
    ]);
    expect(board.body).not.toContain('Asha');
    expect(board.body).not.toContain('Kamla');

    const list = await call('GET', '/display-screens', adminA);
    expect(list.json().data).toHaveLength(1);

    const adminB = await staffLogin(h, 'clinic-b', clinics.b.admin);
    expect((await call('POST', `/display-screens/${screen.id}/revoke`, adminB)).statusCode).toBe(
      404,
    );

    expect((await call('POST', `/display-screens/${screen.id}/revoke`, adminA)).statusCode).toBe(
      204,
    );
    expect((await call('POST', '/display/board', null, { token })).statusCode).toBe(404);
    expect((await call('GET', '/display-screens', adminA)).json().data).toEqual([]);
    expect((await call('POST', '/display/board', null, { token: 'x'.repeat(43) })).statusCode).toBe(
      404,
    );

    const stored = await h.owner.displayScreen.findUniqueOrThrow({ where: { id: screen.id } });
    expect(stored.tokenHash).not.toContain(token);
  });
});

describe('follow-ups', () => {
  const NEXT_TUE = '2026-10-13';

  async function followUp(appointmentId: string, patientId: string, date: string) {
    await h.owner.consultation.create({
      data: {
        organisationId: clinics.a.org.id,
        appointmentId,
        patientId,
        doctorUserId: clinics.a.doctor.userId,
        notesCipher: h.services.cipher.encrypt('{}'),
        followUpDate: new Date(`${date}T00:00:00.000Z`),
      },
    });
  }

  it('lists patients due back on the day, with their booking when they have one', async () => {
    const [asha, kamla] = clinics.a.patients.map((p) => p.id) as [string, string];
    const ashaVisit = await book(asha, { startAt: at(TODAY, '11:00') });
    const kamlaVisit = await book(kamla, { startAt: at(TODAY, '11:15') });
    await followUp(ashaVisit.id, asha, NEXT_TUE);
    await followUp(kamlaVisit.id, kamla, NEXT_TUE);
    const kamlaBack = await book(kamla, { startAt: at(NEXT_TUE, '10:30') });
    // A cancelled booking does not count as coming back.
    const ashaCancelled = await book(asha, { startAt: at(NEXT_TUE, '10:00') });
    expect((await act(ashaCancelled.id, 'cancel', desk, 'Travelling')).statusCode).toBe(200);

    const res = await call('GET', `/queue?date=${NEXT_TUE}`, desk);
    const day = QueueResponse.parse(res.json());
    expect(day.followUps).toMatchObject([
      {
        visitAppointmentId: ashaVisit.id,
        visitDate: TODAY,
        followUpDate: NEXT_TUE,
        patient: { id: asha, name: 'Asha Verma' },
        doctorUserId: clinics.a.doctor.userId,
        clinicId,
        booking: null,
      },
      {
        visitAppointmentId: kamlaVisit.id,
        patient: { id: kamla },
        booking: { id: kamlaBack.id, date: NEXT_TUE, startTime: '10:30', status: 'confirmed' },
      },
    ]);
    // Follow-ups are their own list: the day's bookings still show under Booked.
    expect(day.booked.map((a) => a.id)).toEqual([kamlaBack.id]);

    expect((await queue()).followUps).toEqual([]);
    const otherDoctor = await call(
      'GET',
      `/queue?date=${NEXT_TUE}&doctorId=${clinics.a.admin.userId}`,
      desk,
    );
    expect(QueueResponse.parse(otherDoctor.json()).followUps).toEqual([]);
  });

  it('never shows another clinic’s follow-ups', async () => {
    const [asha] = clinics.a.patients.map((p) => p.id) as [string];
    const visit = await book(asha, { startAt: at(TODAY, '11:00') });
    await followUp(visit.id, asha, NEXT_TUE);
    const otherAdmin = await staffLogin(h, 'clinic-b', clinics.b.admin);
    const res = await call('GET', `/queue?date=${NEXT_TUE}`, otherAdmin);
    expect(QueueResponse.parse(res.json()).followUps).toEqual([]);
  });
});
