import {
  ConsultationRecord,
  ConsultationView,
  PatientChart,
  Vitals,
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

/** A walk-in (checked in on arrival) or a booking later today; Asha unless told otherwise. */
async function visit(body: Record<string, unknown> = { walkIn: true }, patient = 0) {
  const res = await call('POST', '/appointments', desk, {
    patientId: clinics.a.patients[patient]!.id,
    doctorUserId: clinics.a.doctor.userId,
    clinicId,
    consultationTypeId: typeId,
    ...body,
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}

const notes = (over: Record<string, unknown> = {}) => ({
  chiefComplaint: 'Right knee pain for two weeks',
  symptoms: [{ text: 'Knee pain', duration: '2 weeks' }],
  examination: 'Medial joint line tenderness',
  diagnoses: [{ code: 'M17.1', label: 'Primary osteoarthritis of knee' }],
  plan: 'Physiotherapy',
  privateNotes: 'Discuss weight loss next time',
  testsAdvised: 'X-ray right knee AP and lateral',
  advice: 'Ice packs twice a day',
  ...over,
});

describe('consultation notes', () => {
  it('saves encrypted notes with a revision, and rejects a stale tab', async () => {
    const id = await visit();
    const empty = ConsultationView.parse(
      (await call('GET', `/appointments/${id}/consultation`, doctorA)).json(),
    );
    expect(empty.consultation).toBeNull();
    expect(empty.canEdit).toBe(true);
    expect(empty.appointment.status).toBe('checked_in');

    const first = await call('PUT', `/appointments/${id}/consultation`, doctorA, {
      notes: notes(),
      followUpDate: '2026-10-20',
      revision: 0,
    });
    expect(first.statusCode, first.body).toBe(200);
    expect(ConsultationRecord.parse(first.json()).revision).toBe(1);

    // Stored encrypted: no clinical text in the row.
    const row = await h.owner.consultation.findUniqueOrThrow({ where: { appointmentId: id } });
    expect(row.notesCipher.startsWith('v1.')).toBe(true);
    expect(row.notesCipher).not.toContain('knee');

    const stale = await call('PUT', `/appointments/${id}/consultation`, doctorA, {
      notes: notes({ plan: 'Older tab' }),
      followUpDate: null,
      revision: 0,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.fields).toEqual({ revision: 'stale' });

    const second = await call('PUT', `/appointments/${id}/consultation`, doctorA, {
      notes: notes({ plan: 'Physiotherapy and a knee brace' }),
      followUpDate: null,
      revision: 1,
    });
    expect(second.json().revision).toBe(2);

    const view = ConsultationView.parse(
      (await call('GET', `/appointments/${id}/consultation`, doctorA)).json(),
    );
    expect(view.consultation?.notes.plan).toBe('Physiotherapy and a knee brace');
    expect(view.consultation?.notes.diagnoses[0]?.code).toBe('M17.1');
    expect(view.consultation?.followUpDate).toBeNull();

    const audit = await h.owner.auditLog.findMany({
      where: { entityId: id, action: { startsWith: 'consultation.' } },
      orderBy: { at: 'asc' },
    });
    expect(audit.map((a) => a.action)).toEqual([
      'consultation.viewed',
      'consultation.saved',
      'consultation.saved',
      'consultation.viewed',
    ]);
    expect(JSON.stringify(audit.map((a) => a.metadata))).not.toContain('knee');
  });

  it('is for doctors only, and only the visit’s doctor writes', async () => {
    const id = await visit();
    expect((await call('GET', `/appointments/${id}/consultation`, desk)).statusCode).toBe(403);
    expect((await call('GET', `/appointments/${id}/consultation`, adminA)).statusCode).toBe(403);

    const other = await addStaff(h, clinics.a.org.id, 'doctor', 'second@clinic-a.test');
    const second = await staffLogin(h, 'clinic-a', other);
    const view = ConsultationView.parse(
      (await call('GET', `/appointments/${id}/consultation`, second)).json(),
    );
    expect(view.canEdit).toBe(false);
    const put = await call('PUT', `/appointments/${id}/consultation`, second, {
      notes: notes(),
      followUpDate: null,
      revision: 0,
    });
    expect(put.statusCode).toBe(403);
  });

  it('opens for writing only once the patient has checked in', async () => {
    const booked = await visit({ startAt: new Date(Date.UTC(2026, 9, 6, 6, 30)).toISOString() });
    const view = ConsultationView.parse(
      (await call('GET', `/appointments/${booked}/consultation`, doctorA)).json(),
    );
    expect(view.canEdit).toBe(false);
    const put = await call('PUT', `/appointments/${booked}/consultation`, doctorA, {
      notes: notes(),
      followUpDate: null,
      revision: 0,
    });
    expect(put.statusCode).toBe(409);
  });

  it('locks the notes and vitals once the prescription is signed', async () => {
    const id = await visit();
    await call('PUT', `/appointments/${id}/consultation`, doctorA, {
      notes: notes(),
      followUpDate: null,
      revision: 0,
    });
    await h.owner.consultation.update({
      where: { appointmentId: id },
      data: { lockedAt: new Date() },
    });
    const view = ConsultationView.parse(
      (await call('GET', `/appointments/${id}/consultation`, doctorA)).json(),
    );
    expect(view.canEdit).toBe(false);
    expect(view.consultation?.lockedAt).not.toBeNull();
    const put = await call('PUT', `/appointments/${id}/consultation`, doctorA, {
      notes: notes({ plan: 'Changed' }),
      followUpDate: null,
      revision: 1,
    });
    expect(put.statusCode).toBe(409);
    expect((await call('PUT', `/appointments/${id}/vitals`, desk, { pulse: 80 })).statusCode).toBe(
      409,
    );
  });
});

describe('vitals', () => {
  it('front desk records them, the doctor sees them with BMI', async () => {
    const id = await visit();
    expect((await call('GET', `/appointments/${id}/vitals`, desk)).json()).toEqual({
      vitals: null,
    });

    const saved = await call('PUT', `/appointments/${id}/vitals`, desk, {
      bpSystolic: 128,
      bpDiastolic: 84,
      pulse: 76,
      temperatureC: 36.8,
      spo2: 98,
      weightKg: 70,
      heightCm: 175,
      painScore: 6,
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const vitals = Vitals.parse(saved.json());
    expect(vitals.bmi).toBe(22.9);
    expect(vitals.temperatureC).toBe(36.8);

    const view = ConsultationView.parse(
      (await call('GET', `/appointments/${id}/consultation`, doctorA)).json(),
    );
    expect(view.vitals?.bpSystolic).toBe(128);

    // The whole set is replaced: readings left out are cleared.
    const replaced = Vitals.parse(
      (
        await call('PUT', `/appointments/${id}/vitals`, doctorA, { pulse: 80, weightKg: 71.5 })
      ).json(),
    );
    expect(replaced).toMatchObject({ pulse: 80, weightKg: 71.5, bpSystolic: null, bmi: null });
  });

  it('rejects impossible readings, clinic admins and visits that did not happen', async () => {
    const id = await visit();
    expect((await call('PUT', `/appointments/${id}/vitals`, desk, { spo2: 140 })).statusCode).toBe(
      400,
    );
    expect(
      (await call('PUT', `/appointments/${id}/vitals`, desk, { painScore: 11 })).statusCode,
    ).toBe(400);
    expect((await call('GET', `/appointments/${id}/vitals`, adminA)).statusCode).toBe(403);

    const later = await visit({ startAt: new Date(Date.UTC(2026, 9, 6, 6, 30)).toISOString() }, 1);
    await call('POST', `/appointments/${later}/actions`, desk, {
      action: 'cancel',
      reason: 'Travelling',
    });
    expect(
      (await call('PUT', `/appointments/${later}/vitals`, desk, { pulse: 70 })).statusCode,
    ).toBe(409);
  });
});

describe('patient chart', () => {
  it('doctors add, list and remove allergies, conditions and medicines', async () => {
    const patientId = clinics.a.patients[0]!.id;
    const allergy = await call('POST', `/patients/${patientId}/allergies`, doctorA, {
      substance: 'Penicillin',
      reaction: 'Rash',
      source: 'patient',
    });
    expect(allergy.statusCode, allergy.body).toBe(201);
    expect(allergy.json()).toMatchObject({ substance: 'Penicillin', source: 'patient' });
    const condition = await call('POST', `/patients/${patientId}/conditions`, doctorA, {
      name: 'Chronic kidney disease',
      icd10Code: 'N18.9',
    });
    expect(condition.statusCode, condition.body).toBe(201);
    await call('POST', `/patients/${patientId}/medications`, doctorA, {
      name: 'Amlodipine',
      dose: '5 mg daily',
    });

    let chart = PatientChart.parse(
      (await call('GET', `/patients/${patientId}/chart`, doctorA)).json(),
    );
    expect(chart.allergies.map((a) => a.substance)).toEqual(['Penicillin']);
    expect(chart.conditions[0]).toMatchObject({ icd10Code: 'N18.9', source: 'doctor' });
    expect(chart.medications[0]).toMatchObject({ name: 'Amlodipine', dose: '5 mg daily' });

    const allergyId = allergy.json().id;
    const removed = await call(
      'POST',
      `/patients/${patientId}/allergies/${allergyId}/remove`,
      doctorA,
      {
        reason: 'Tolerated amoxicillin in 2025',
      },
    );
    expect(removed.statusCode).toBe(204);
    chart = PatientChart.parse((await call('GET', `/patients/${patientId}/chart`, doctorA)).json());
    expect(chart.allergies).toEqual([]);
    const kept = await h.owner.allergy.findUniqueOrThrow({ where: { id: allergyId } });
    expect(kept.removedReason).toBe('Tolerated amoxicillin in 2025');
    expect(
      (
        await call('POST', `/patients/${patientId}/allergies/${allergyId}/remove`, doctorA, {
          reason: 'Again',
        })
      ).statusCode,
    ).toBe(404);

    const actions = (
      await h.owner.auditLog.findMany({ where: { organisationId: clinics.a.org.id } })
    ).map((a) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'allergy.added',
        'condition.added',
        'medication.added',
        'allergy.removed',
        'chart.viewed',
      ]),
    );
  });

  it('is closed to front desk and clinic admins, and checks codes', async () => {
    const patientId = clinics.a.patients[0]!.id;
    expect((await call('GET', `/patients/${patientId}/chart`, desk)).statusCode).toBe(403);
    expect((await call('GET', `/patients/${patientId}/chart`, adminA)).statusCode).toBe(403);
    expect(
      (await call('POST', `/patients/${patientId}/allergies`, desk, { substance: 'Sulfa' }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await call('POST', `/patients/${patientId}/conditions`, doctorA, {
          name: 'Gout',
          icd10Code: 'gout',
        })
      ).statusCode,
    ).toBe(400);
  });

  it('lists completed visits with their complaint and diagnoses', async () => {
    const id = await visit();
    await call('POST', `/appointments/${id}/actions`, doctorA, { action: 'start' });
    await call('PUT', `/appointments/${id}/consultation`, doctorA, {
      notes: notes(),
      followUpDate: null,
      revision: 0,
    });
    const before = PatientChart.parse(
      (await call('GET', `/patients/${clinics.a.patients[0]!.id}/chart`, doctorA)).json(),
    );
    expect(before.recentVisits).toEqual([]);
    await call('POST', `/appointments/${id}/actions`, doctorA, { action: 'complete' });
    const chart = PatientChart.parse(
      (await call('GET', `/patients/${clinics.a.patients[0]!.id}/chart`, doctorA)).json(),
    );
    expect(chart.recentVisits).toHaveLength(1);
    expect(chart.recentVisits[0]).toMatchObject({
      appointmentId: id,
      date: TODAY,
      chiefComplaint: 'Right knee pain for two weeks',
      diagnoses: [{ code: 'M17.1', label: 'Primary osteoarthritis of knee' }],
    });
  });
});

describe('tenant isolation', () => {
  it('another organisation’s doctor sees none of it', async () => {
    const id = await visit();
    const patientId = clinics.a.patients[0]!.id;
    const doctorB = await staffLogin(h, 'clinic-b', clinics.b.doctor);
    expect((await call('GET', `/appointments/${id}/consultation`, doctorB)).statusCode).toBe(404);
    expect((await call('GET', `/appointments/${id}/vitals`, doctorB)).statusCode).toBe(404);
    expect(
      (await call('PUT', `/appointments/${id}/vitals`, doctorB, { pulse: 70 })).statusCode,
    ).toBe(404);
    expect((await call('GET', `/patients/${patientId}/chart`, doctorB)).statusCode).toBe(404);
    expect(
      (await call('POST', `/patients/${patientId}/allergies`, doctorB, { substance: 'Penicillin' }))
        .statusCode,
    ).toBe(404);
  });
});
