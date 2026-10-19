/**
 * Referrals through the API (PRD §7.2), slice 1: made from a visit by its doctor, inside
 * the organisation or outside it; listed for the doctors who sent and received them; the
 * receiving doctor marks them seen and either doctor closes them. Doctors only. An open
 * internal referral opens the chart under "own patients only"; an external one grants
 * nothing. Tenancy and the database's own guards. Personas are synthetic.
 */
import {
  AuditListResponse,
  Referral,
  ReferralCounts,
  ReferralList,
  VisitReferralList,
  type TokenResponse,
} from '@dhc/contracts';
import { withTenant } from '@dhc/db';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
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
let doctor: TokenResponse;
let second: StaffFixture;
let secondDoctor: TokenResponse;
let third: StaffFixture;
let thirdDoctor: TokenResponse;
let desk: TokenResponse;
let admin: TokenResponse;
let doctorB: TokenResponse;
let clinicId: string;
let typeId: string;

beforeEach(async () => {
  h.clock.ms = Date.UTC(2026, 9, 6, 4, 30);
  await resetDatabase(h.owner);
  clinics = await seedTwoClinics(h);
  const org = clinics.a.org.id;
  second = await addStaff(h, org, 'doctor', 'second@clinic-a.test');
  third = await addStaff(h, org, 'doctor', 'third@clinic-a.test');
  doctor = await staffLogin(h, 'clinic-a', clinics.a.doctor);
  secondDoctor = await staffLogin(h, 'clinic-a', second);
  thirdDoctor = await staffLogin(h, 'clinic-a', third);
  desk = await staffLogin(
    h,
    'clinic-a',
    await addStaff(h, org, 'front_desk', 'desk@clinic-a.test'),
  );
  admin = await staffLogin(h, 'clinic-a', clinics.a.admin);
  doctorB = await staffLogin(h, 'clinic-b', clinics.b.doctor);
  clinicId = (await h.owner.clinic.create({ data: { organisationId: org, name: 'Main clinic' } }))
    .id;
  typeId = (
    await h.owner.consultationType.create({
      data: {
        organisationId: org,
        name: 'In-person consultation',
        mode: 'in_person',
        defaultDurationMin: 15,
        feePaise: 80000,
      },
    })
  ).id;
});

afterAll(async () => {
  await h.app.close();
  await h.owner.$disconnect();
});

const call = (
  method: string,
  url: string,
  tokens: TokenResponse | null,
  payload?: unknown,
  headers: Record<string, string> = {},
) =>
  h.app.inject({
    method: method as 'GET',
    url: `/v1${url}`,
    headers: { ...(tokens ? bearer(tokens) : {}), ...headers },
    payload: payload as object,
  });

const patientId = () => clinics.a.patients[0]!.id;

let token = 0;
async function visit(
  doctorUserId = clinics.a.doctor.userId,
  status: 'confirmed' | 'checked_in' | 'in_consultation' | 'completed' = 'in_consultation',
  patient = patientId(),
) {
  const startAt = new Date('2026-10-06T04:30:00.000Z');
  token += 1;
  const row = await h.owner.appointment.create({
    data: {
      organisationId: clinics.a.org.id,
      patientId: patient,
      doctorUserId,
      clinicId,
      consultationTypeId: typeId,
      date: new Date('2026-10-06T00:00:00.000Z'),
      startAt,
      endAt: new Date(startAt.getTime() + 15 * 60_000),
      status,
      source: 'front_desk',
      tokenNumber: token,
      createdByUserId: doctorUserId,
    },
  });
  return row.id;
}

const internal = (over: Record<string, unknown> = {}) => ({
  kind: 'internal',
  receivingDoctorUserId: second.userId,
  reason: 'Persistent knee effusion; please assess for arthroscopy.',
  urgency: 'soon',
  notes: 'Aspirated once last month.',
  ...over,
});
const external = (over: Record<string, unknown> = {}) => ({
  kind: 'external',
  external: {
    name: 'Dr Meera Iyer',
    specialty: 'Cardiology',
    hospital: 'City Heart Hospital',
    phone: '+91 90000 00001',
  },
  reason: 'Cardiology opinion before knee surgery.',
  urgency: 'routine',
  ...over,
});

async function refer(visitId: string, body: unknown = internal(), tokens = doctor) {
  const res = await call('POST', `/appointments/${visitId}/referrals`, tokens, body);
  expect(res.statusCode, res.body).toBe(201);
  return Referral.parse(res.json());
}

const ownPatientsOnly = () =>
  h.owner.organisationSettings.create({
    data: { organisationId: clinics.a.org.id, chartModel: 'own_patients' },
  });

describe('making a referral', () => {
  it('refers inside the clinic from the visit, and lists it for both doctors', async () => {
    const visitId = await visit();
    const made = await refer(visitId);
    expect(made).toMatchObject({
      kind: 'internal',
      status: 'sent',
      urgency: 'soon',
      patient: { id: patientId(), name: 'Asha Verma' },
      referringDoctor: { userId: clinics.a.doctor.userId },
      receivingDoctor: { userId: second.userId },
      external: null,
      appointmentId: visitId,
      visitDate: '2026-10-06',
      // 04:30 plus 30 seconds for each of the six sign-ins.
      sentAt: '2026-10-06T04:33:00.000Z',
      seenAt: null,
      closedAt: null,
      reason: 'Persistent knee effusion; please assess for arthroscopy.',
      notes: 'Aspirated once last month.',
      role: 'referring',
      canClose: true,
    });

    const sent = ReferralList.parse((await call('GET', '/referrals?box=sent', doctor)).json());
    expect(sent.data.map((r) => r.id)).toEqual([made.id]);
    // Lists carry no clinical text.
    expect(sent.data[0]).not.toHaveProperty('reason');
    expect(sent.data[0]).not.toHaveProperty('notes');
    const received = ReferralList.parse(
      (await call('GET', '/referrals?box=received', secondDoctor)).json(),
    );
    expect(received.data.map((r) => r.id)).toEqual([made.id]);
    expect(
      ReferralList.parse((await call('GET', '/referrals?box=received', doctor)).json()).data,
    ).toEqual([]);
    expect(
      ReferralList.parse((await call('GET', '/referrals?box=sent', thirdDoctor)).json()).data,
    ).toEqual([]);

    expect(
      ReferralCounts.parse((await call('GET', '/referrals/counts', secondDoctor)).json()),
    ).toEqual({ receivedNew: 1, receivedOpen: 1, sentOpen: 0 });
    expect(ReferralCounts.parse((await call('GET', '/referrals/counts', doctor)).json())).toEqual({
      receivedNew: 0,
      receivedOpen: 0,
      sentOpen: 1,
    });

    // The consultation screen lists the visit's referrals.
    const atVisit = VisitReferralList.parse(
      (await call('GET', `/appointments/${visitId}/referrals`, doctor)).json(),
    );
    expect(atVisit.data.map((r) => r.id)).toEqual([made.id]);
    // A doctor who is not a party sees none of them.
    expect(
      VisitReferralList.parse(
        (await call('GET', `/appointments/${visitId}/referrals`, thirdDoctor)).json(),
      ).data,
    ).toEqual([]);

    // Audited with IDs, kind and urgency only: no patient, reason or notes.
    const audit = await h.owner.auditLog.findFirstOrThrow({
      where: { action: 'referral.created' },
    });
    expect(audit).toMatchObject({
      entityType: 'referral',
      entityId: made.id,
      actorUserId: clinics.a.doctor.userId,
    });
    expect(audit.metadata).toEqual({
      appointmentId: visitId,
      kind: 'internal',
      urgency: 'soon',
      receivingDoctorUserId: second.userId,
    });
    expect(JSON.stringify(audit.metadata)).not.toMatch(/Asha|knee|Aspirated/i);
    // Lists name patients, so each request is audited: the box and count only.
    const listed = await h.owner.auditLog.findMany({
      where: { action: 'referral.listed', actorUserId: second.userId },
    });
    expect(listed.map((e) => [e.entityType, e.entityId, e.metadata])).toEqual([
      ['user', second.userId, { box: 'received', count: 1 }],
    ]);
    const visitView = await h.owner.auditLog.findFirstOrThrow({
      where: { action: 'referral.visit_viewed' },
    });
    expect(visitView).toMatchObject({ entityType: 'appointment', entityId: visitId });
    expect(visitView.metadata).toEqual({ count: 1 });
  });

  it('refers outside the clinic with a name, the rest optional', async () => {
    const visitId = await visit(clinics.a.doctor.userId, 'completed');
    const made = await refer(visitId, external());
    expect(made).toMatchObject({
      kind: 'external',
      receivingDoctor: null,
      external: {
        name: 'Dr Meera Iyer',
        specialty: 'Cardiology',
        hospital: 'City Heart Hospital',
        phone: '+91 90000 00001',
      },
      notes: null,
    });
    const bare = await refer(visitId, external({ external: { name: 'District Hospital' } }));
    expect(bare.external).toEqual({
      name: 'District Hospital',
      specialty: null,
      hospital: null,
      phone: null,
    });
    // Newest first.
    const sent = ReferralList.parse((await call('GET', '/referrals?box=sent', doctor)).json());
    expect(sent.data).toHaveLength(2);
  });

  it('pages the lists with a cursor', async () => {
    const visitId = await visit();
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      h.clock.advance(60);
      ids.push((await refer(visitId)).id);
    }
    const first = ReferralList.parse(
      (await call('GET', '/referrals?box=received&limit=2', secondDoctor)).json(),
    );
    expect(first.data.map((r) => r.id)).toEqual([ids[2], ids[1]]);
    const next = ReferralList.parse(
      (
        await call(
          'GET',
          `/referrals?box=received&limit=2&cursor=${first.nextCursor}`,
          secondDoctor,
        )
      ).json(),
    );
    expect(next).toEqual({ data: [expect.objectContaining({ id: ids[0] })], nextCursor: null });
    const bad = await call('GET', '/referrals?box=received&cursor=bm9wZQ', secondDoctor);
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.fields).toEqual({ cursor: 'invalid' });
  });

  it('makes one referral per Idempotency-Key', async () => {
    const visitId = await visit();
    const headers = { 'idempotency-key': 'refer-once-123' };
    const a = await call('POST', `/appointments/${visitId}/referrals`, doctor, internal(), headers);
    const b = await call('POST', `/appointments/${visitId}/referrals`, doctor, internal(), headers);
    expect(a.statusCode).toBe(201);
    expect(b.json().id).toBe(a.json().id);
    expect(await h.owner.referral.count()).toBe(1);
  });

  it('only the visit’s doctor refers, once the patient has checked in', async () => {
    const visitId = await visit();
    const notTheirs = await call('POST', `/appointments/${visitId}/referrals`, secondDoctor, {
      ...internal(),
      receivingDoctorUserId: third.userId,
    });
    expect(notTheirs.statusCode).toBe(403);

    const booked = await visit(clinics.a.doctor.userId, 'confirmed');
    const early = await call('POST', `/appointments/${booked}/referrals`, doctor, internal());
    expect(early.statusCode).toBe(409);
    expect(early.json().error.fields).toEqual({ status: 'confirmed' });
    expect(await h.owner.referral.count()).toBe(0);
  });

  it('refuses a bad recipient or body', async () => {
    const visitId = await visit();
    const post = (body: unknown) =>
      call('POST', `/appointments/${visitId}/referrals`, doctor, body);

    const self = await post(internal({ receivingDoctorUserId: clinics.a.doctor.userId }));
    expect(self.statusCode).toBe(400);
    expect(self.json().error.fields).toEqual({ receivingDoctorUserId: 'self' });
    // Not a doctor here: the clinic admin, another clinic's doctor, an unknown ID.
    for (const userId of [
      clinics.a.admin.userId,
      clinics.b.doctor.userId,
      '00000000-0000-4000-8000-000000000000',
    ]) {
      const res = await post(internal({ receivingDoctorUserId: userId }));
      expect(res.statusCode, userId).toBe(400);
      expect(res.json().error.fields).toEqual({ receivingDoctorUserId: 'invalid' });
    }
    // A doctor whose membership was revoked, or whose account was disabled.
    await h.owner.membership.updateMany({
      where: { userId: third.userId },
      data: { status: 'revoked' },
    });
    expect((await post(internal({ receivingDoctorUserId: third.userId }))).statusCode).toBe(400);
    await h.owner.user.update({ where: { id: second.userId }, data: { status: 'disabled' } });
    expect((await post(internal())).statusCode).toBe(400);

    for (const body of [
      external({ external: { name: '  ' } }),
      external({ external: { name: 'Clinic', phone: 'call me' } }),
      internal({ reason: '' }),
      internal({ urgency: 'asap' }),
      { ...internal(), kind: 'elsewhere' },
    ]) {
      expect((await post(body)).statusCode, JSON.stringify(body)).toBe(400);
    }
    expect(await h.owner.referral.count()).toBe(0);
  });

  it('keeps the front desk and clinic admins out entirely', async () => {
    const visitId = await visit();
    const made = await refer(visitId);
    for (const tokens of [desk, admin]) {
      for (const res of [
        await call('POST', `/appointments/${visitId}/referrals`, tokens, internal()),
        await call('GET', `/appointments/${visitId}/referrals`, tokens),
        await call('GET', '/referrals?box=sent', tokens),
        await call('GET', '/referrals/counts', tokens),
        await call('GET', `/referrals/${made.id}`, tokens),
        await call('POST', `/referrals/${made.id}/seen`, tokens),
        await call('POST', `/referrals/${made.id}/close`, tokens, {}),
      ]) {
        expect(res.statusCode).toBe(403);
      }
    }
    expect((await call('GET', '/referrals?box=sent', null)).statusCode).toBe(401);
  });
});

describe('seen and closed', () => {
  it('the receiving doctor’s opening marks it seen, once', async () => {
    const made = await refer(await visit());
    // Only the receiving doctor marks it seen; the referring one just reads it.
    expect((await call('POST', `/referrals/${made.id}/seen`, doctor)).statusCode).toBe(403);
    expect(Referral.parse((await call('GET', `/referrals/${made.id}`, doctor)).json()).status).toBe(
      'sent',
    );

    h.clock.advance(600);
    const seen = Referral.parse(
      (await call('POST', `/referrals/${made.id}/seen`, secondDoctor)).json(),
    );
    expect(seen).toMatchObject({
      status: 'seen',
      seenAt: '2026-10-06T04:43:00.000Z',
      role: 'receiving',
      reason: made.reason,
    });
    h.clock.advance(600);
    const again = Referral.parse(
      (await call('POST', `/referrals/${made.id}/seen`, secondDoctor)).json(),
    );
    expect(again.seenAt).toBe('2026-10-06T04:43:00.000Z');
    expect(await h.owner.auditLog.count({ where: { action: 'referral.seen' } })).toBe(1);
    expect(
      ReferralCounts.parse((await call('GET', '/referrals/counts', secondDoctor)).json()),
    ).toEqual({ receivedNew: 0, receivedOpen: 1, sentOpen: 0 });

    // A doctor who is neither side finds nothing.
    for (const res of [
      await call('GET', `/referrals/${made.id}`, thirdDoctor),
      await call('POST', `/referrals/${made.id}/seen`, thirdDoctor),
      await call('POST', `/referrals/${made.id}/close`, thirdDoctor, {}),
    ]) {
      expect(res.statusCode).toBe(404);
    }
  });

  it('either doctor closes it with an optional note; closing is final', async () => {
    const visitId = await visit();
    const a = await refer(visitId);
    const b = await refer(visitId, external());
    h.clock.advance(3600);

    const byReceiver = Referral.parse(
      (
        await call('POST', `/referrals/${a.id}/close`, secondDoctor, {
          note: 'Seen in clinic; arthroscopy planned.',
        })
      ).json(),
    );
    expect(byReceiver).toMatchObject({
      status: 'closed',
      closedAt: '2026-10-06T05:33:00.000Z',
      closedBy: { userId: second.userId },
      closeNote: 'Seen in clinic; arthroscopy planned.',
      canClose: false,
    });
    const byReferrer = Referral.parse(
      (await call('POST', `/referrals/${b.id}/close`, doctor, {})).json(),
    );
    expect(byReferrer).toMatchObject({ status: 'closed', closeNote: null });

    const twice = await call('POST', `/referrals/${a.id}/close`, doctor, {});
    expect(twice.statusCode).toBe(409);
    expect(twice.json().error.fields).toEqual({ status: 'closed' });
    // Opening a closed referral changes nothing.
    expect(
      Referral.parse((await call('POST', `/referrals/${a.id}/seen`, secondDoctor)).json()).status,
    ).toBe('closed');

    const closed = ReferralList.parse(
      (await call('GET', '/referrals?box=sent&status=closed', doctor)).json(),
    );
    expect(closed.data).toHaveLength(2);
    // The note's text never reaches the log.
    const entries = await h.owner.auditLog.findMany({ where: { action: 'referral.closed' } });
    expect(entries.map((e) => e.metadata)).toEqual(
      expect.arrayContaining([
        { by: 'receiving', from: 'sent', note: true },
        { by: 'referring', from: 'sent', note: false },
      ]),
    );
    expect(JSON.stringify(entries)).not.toMatch(/arthroscopy/);

    // The clinic admin's audit log shows them by ID under the referral area.
    const log = AuditListResponse.parse(
      (await call('GET', '/audit-log?action=referral.', admin)).json(),
    );
    expect(new Set(log.data.map((e) => e.action))).toEqual(
      new Set(['referral.created', 'referral.closed', 'referral.viewed', 'referral.listed']),
    );
  });
});

describe('chart access under “own patients only”', () => {
  it('an open internal referral opens the chart, notes and prescriptions to the receiver', async () => {
    const visitId = await visit();
    await ownPatientsOnly();
    const chart = () => call('GET', `/patients/${patientId()}/chart`, secondDoctor);
    const reads = () =>
      Promise.all([
        chart(),
        call('GET', `/appointments/${visitId}/consultation`, secondDoctor),
        call('GET', `/appointments/${visitId}/prescription`, secondDoctor),
        call('GET', `/patients/${patientId()}/last-prescription`, secondDoctor),
        call('GET', `/patients/${patientId()}/test-orders`, secondDoctor),
      ]);

    for (const res of await reads()) {
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json().error.code).toBe('CHART_RESTRICTED');
    }

    const made = await refer(visitId);
    for (const res of await reads()) expect(res.statusCode, res.body).toBe(200);
    await call('POST', `/referrals/${made.id}/seen`, secondDoctor);
    expect((await chart()).statusCode).toBe(200);

    // Reading is not writing: the referral does not make the visit theirs.
    const write = await call('PUT', `/appointments/${visitId}/consultation`, secondDoctor, {
      notes: {},
      followUpDate: null,
      revision: 0,
    });
    expect(write.statusCode).toBe(403);

    // A third doctor still cannot.
    expect((await call('GET', `/patients/${patientId()}/chart`, thirdDoctor)).statusCode).toBe(403);

    // Once closed, the referral no longer opens the chart.
    await call('POST', `/referrals/${made.id}/close`, doctor, {});
    const after = await chart();
    expect(after.statusCode).toBe(403);
    expect(after.json().error.code).toBe('CHART_RESTRICTED');
    // The referral itself stays readable to both doctors.
    expect((await call('GET', `/referrals/${made.id}`, secondDoctor)).statusCode).toBe(200);
  });

  it('a referral from a visit cancelled afterwards opens nothing', async () => {
    const visitId = await visit(clinics.a.doctor.userId, 'checked_in');
    await ownPatientsOnly();
    const made = await refer(visitId);
    expect((await call('GET', `/patients/${patientId()}/chart`, secondDoctor)).statusCode).toBe(
      200,
    );
    const cancelled = await call('POST', `/appointments/${visitId}/actions`, desk, {
      action: 'cancel',
      reason: 'Patient left before the consultation',
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    const res = await call('GET', `/patients/${patientId()}/chart`, secondDoctor);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('CHART_RESTRICTED');
    // The referral itself is still there for both doctors to read and close.
    expect(
      Referral.parse((await call('GET', `/referrals/${made.id}`, secondDoctor)).json()).status,
    ).toBe('sent');
  });

  it('an external referral, or one to someone else, grants nothing', async () => {
    const visitId = await visit();
    await ownPatientsOnly();
    await refer(visitId, external());
    await refer(visitId, internal({ receivingDoctorUserId: third.userId }));
    const res = await call('GET', `/patients/${patientId()}/chart`, secondDoctor);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('CHART_RESTRICTED');
    expect((await call('GET', `/patients/${patientId()}/chart`, thirdDoctor)).statusCode).toBe(200);
  });

  it('a referral of a duplicate later merged into the record counts', async () => {
    const duplicate = await h.owner.patient.create({
      data: { organisationId: clinics.a.org.id, uhid: 'CL-DUP001', name: 'Asha Verma' },
    });
    await refer(await visit(clinics.a.doctor.userId, 'completed', duplicate.id));
    await ownPatientsOnly();
    await h.owner.patient.update({
      where: { id: duplicate.id },
      data: { mergedIntoId: patientId(), mergedAt: h.clock.now() },
    });
    expect((await call('GET', `/patients/${patientId()}/chart`, secondDoctor)).statusCode).toBe(
      200,
    );
    // Listed under the record in use.
    const received = ReferralList.parse(
      (await call('GET', '/referrals?box=received', secondDoctor)).json(),
    );
    expect(received.data[0]!.patient).toMatchObject({ id: patientId(), uhid: 'CL-000001' });
    // And a merged record takes no new referrals.
    const old = await h.owner.appointment.findFirstOrThrow({ where: { patientId: duplicate.id } });
    const res = await call('POST', `/appointments/${old.id}/referrals`, doctor, internal());
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('PATIENT_MERGED');
  });

  it('a shared chart needs no referral', async () => {
    await visit();
    expect((await call('GET', `/patients/${patientId()}/chart`, secondDoctor)).statusCode).toBe(
      200,
    );
  });
});

describe('tenancy and the database’s guards', () => {
  it('never shows or touches another clinic’s referrals', async () => {
    const visitId = await visit();
    const made = await refer(visitId);
    for (const res of [
      await call('GET', `/referrals/${made.id}`, doctorB),
      await call('POST', `/referrals/${made.id}/seen`, doctorB),
      await call('POST', `/referrals/${made.id}/close`, doctorB, {}),
      await call('GET', `/appointments/${visitId}/referrals`, doctorB),
      await call('POST', `/appointments/${visitId}/referrals`, doctorB, {
        ...internal(),
        receivingDoctorUserId: clinics.b.admin.userId,
      }),
    ]) {
      expect(res.statusCode).toBe(404);
    }
    expect(
      ReferralList.parse((await call('GET', '/referrals?box=sent', doctorB)).json()).data,
    ).toEqual([]);
    expect(ReferralCounts.parse((await call('GET', '/referrals/counts', doctorB)).json())).toEqual({
      receivedNew: 0,
      receivedOpen: 0,
      sentOpen: 0,
    });
    // Under row-level security clinic B does not see the row at all.
    expect(await withTenant(h.services.db, clinics.b.org.id, (tx) => tx.referral.count())).toBe(0);
  });

  it('refuses rows that cross clinics or do not match their visit', async () => {
    const visitId = await visit();
    const base = {
      organisationId: clinics.a.org.id,
      appointmentId: visitId,
      patientId: patientId(),
      referringDoctorUserId: clinics.a.doctor.userId,
      kind: 'internal' as const,
      receivingDoctorUserId: second.userId,
      reason: 'Opinion',
      urgency: 'routine' as const,
      sentAt: h.clock.now(),
    };
    for (const data of [
      // Another clinic's row pointing at this clinic's visit and patient.
      { ...base, organisationId: clinics.b.org.id, referringDoctorUserId: clinics.b.doctor.userId },
      // A patient other than the visit's, or a referrer other than its doctor.
      { ...base, patientId: clinics.a.patients[1]!.id },
      { ...base, referringDoctorUserId: second.userId, receivingDoctorUserId: third.userId },
      // A receiver who is not a doctor of this clinic.
      { ...base, receivingDoctorUserId: clinics.b.doctor.userId },
      { ...base, receivingDoctorUserId: clinics.a.admin.userId },
    ]) {
      await expect(h.owner.referral.create({ data })).rejects.toThrow(/does not match|is not a/);
    }
    // Shape and status checks.
    for (const data of [
      { ...base, receivingDoctorUserId: clinics.a.doctor.userId },
      { ...base, externalName: 'City Hospital' },
      { ...base, kind: 'external' as const, receivingDoctorUserId: null },
      { ...base, reason: '   ' },
      {
        ...base,
        kind: 'external' as const,
        receivingDoctorUserId: null,
        externalName: 'Clinic',
        externalPhone: 'call me',
      },
      { ...base, status: 'seen' as const, seenAt: h.clock.now() },
    ]) {
      await expect(h.owner.referral.create({ data })).rejects.toThrow();
    }
    expect(await h.owner.referral.count()).toBe(0);
  });

  it('locks a referral once made: only the status moves forward', async () => {
    const visitId = await visit();
    const made = await refer(visitId);
    const where = { id: made.id };
    await expect(h.owner.referral.update({ where, data: { reason: 'Changed' } })).rejects.toThrow(
      /only a referral's status/,
    );
    await expect(h.owner.referral.delete({ where })).rejects.toThrow(/never deleted/);
    await call('POST', `/referrals/${made.id}/seen`, secondDoctor);
    await expect(
      h.owner.referral.update({ where, data: { status: 'sent', seenAt: null } }),
    ).rejects.toThrow();
    await call('POST', `/referrals/${made.id}/close`, doctor, {});
    await expect(
      h.owner.referral.update({ where, data: { closeNote: 'Edited later' } }),
    ).rejects.toThrow(/closed referral/);
    // The visit keeps its patient and doctor while it has referrals.
    await expect(
      h.owner.appointment.update({
        where: { id: visitId },
        data: { doctorUserId: second.userId },
      }),
    ).rejects.toThrow(/has referrals/);
  });
});
