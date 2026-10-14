/**
 * Merging duplicate patient records (PRD §3.2, §5.3): front desk asks, a clinic admin
 * decides. The living record moves to the kept patient, history stays where it was written
 * and shows under the kept patient, and the duplicate is closed for good.
 */
import {
  LastPrescription,
  PatientChart,
  PatientDetail,
  PatientListResponse,
  PatientMergeList,
  PatientMergeRequest,
  AppointmentList,
  type TokenResponse,
} from '@dhc/contracts';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addStaff,
  bearer,
  createHarness,
  resetDatabase,
  seedTwoClinics,
  staffLogin,
} from './harness';

const h = createHarness();
let clinics: Awaited<ReturnType<typeof seedTwoClinics>>;
let desk: TokenResponse;
let adminA: TokenResponse;
let doctorA: TokenResponse;
let clinicId: string;
let typeId: string;

beforeEach(async () => {
  await resetDatabase(h.owner);
  clinics = await seedTwoClinics(h);
  const frontDesk = await addStaff(h, clinics.a.org.id, 'front_desk', 'desk@clinic-a.test');
  desk = await staffLogin(h, 'clinic-a', frontDesk);
  adminA = await staffLogin(h, 'clinic-a', clinics.a.admin);
  doctorA = await staffLogin(h, 'clinic-a', clinics.a.doctor);
  const org = clinics.a.org.id;
  clinicId = (await h.owner.clinic.create({ data: { organisationId: org, name: 'Main clinic' } }))
    .id;
  typeId = (
    await h.owner.consultationType.create({
      data: {
        organisationId: org,
        name: 'In-person',
        mode: 'in_person',
        defaultDurationMin: 15,
        feePaise: 50000,
      },
    })
  ).id;
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

let token = 0;
async function visit(patientId: string, startAt: string, status: 'completed' | 'confirmed') {
  token += 1;
  const start = new Date(startAt);
  return h.owner.appointment.create({
    data: {
      organisationId: clinics.a.org.id,
      patientId,
      doctorUserId: clinics.a.doctor.userId,
      clinicId,
      consultationTypeId: typeId,
      date: new Date(`${startAt.slice(0, 10)}T00:00:00.000Z`),
      startAt: start,
      endAt: new Date(start.getTime() + 15 * 60_000),
      status,
      source: 'front_desk',
      tokenNumber: token,
      createdByUserId: clinics.a.doctor.userId,
    },
  });
}

/**
 * Asha's duplicate ("Asha V.") has a history: an allergy, a tag, a completed visit with a
 * prescription, an upcoming booking and a child who lists it as guardian.
 */
async function duplicateWithHistory() {
  const org = clinics.a.org.id;
  const kept = clinics.a.patients[0]!;
  const dup = await h.owner.patient.create({
    data: { organisationId: org, uhid: 'CL-000099', name: 'Asha V.', phone: '+919811111111' },
  });
  const child = await h.owner.patient.create({
    data: { organisationId: org, uhid: 'CL-000100', name: 'Riya V.', guardianPatientId: dup.id },
  });
  await h.owner.allergy.create({
    data: {
      organisationId: org,
      patientId: dup.id,
      substance: 'Penicillin',
      source: 'doctor',
      recordedByUserId: clinics.a.doctor.userId,
    },
  });
  const tag = await h.owner.tag.create({
    data: { organisationId: org, name: 'Diabetic', colour: '#aa0000' },
  });
  await h.owner.patientTag.create({
    data: {
      organisationId: org,
      patientId: dup.id,
      tagId: tag.id,
      addedByUserId: clinics.a.doctor.userId,
    },
  });
  const past = await visit(dup.id, '2026-09-01T04:30:00.000Z', 'completed');
  await h.owner.consultation.create({
    data: {
      organisationId: org,
      appointmentId: past.id,
      patientId: dup.id,
      doctorUserId: clinics.a.doctor.userId,
      notesCipher: h.services.cipher.encrypt('{}'),
    },
  });
  await h.owner.prescription.create({
    data: {
      organisationId: org,
      appointmentId: past.id,
      patientId: dup.id,
      doctorUserId: clinics.a.doctor.userId,
      items: {
        create: [
          {
            id: randomUUID(),
            organisationId: org,
            name: 'Metformin 500',
            steps: [
              { dose: '1 tablet', frequency: '1-0-1', durationValue: 30, durationUnit: 'days' },
            ],
            remarks: '',
            sortOrder: 0,
          },
        ],
      },
    },
  });
  const upcoming = await visit(dup.id, '2026-12-01T04:30:00.000Z', 'confirmed');
  return { kept, dup, child, tag, past, upcoming };
}

const ask = (sourcePatientId: string, targetPatientId: string, tokens = desk) =>
  call('POST', '/patient-merges', tokens, {
    sourcePatientId,
    targetPatientId,
    reason: 'Registered twice at the front desk',
  });

describe('merge requests', () => {
  it('are asked for by staff who register patients and listed for the clinic admin', async () => {
    const { kept, dup } = await duplicateWithHistory();
    const res = await ask(dup.id, kept.id);
    expect(res.statusCode, res.body).toBe(201);
    const created = PatientMergeRequest.parse(res.json());
    expect(created).toMatchObject({
      status: 'pending',
      source: { uhid: 'CL-000099', name: 'Asha V.', phone: '+919811111111', visits: 1 },
      target: { name: 'Asha Verma', visits: 0 },
      reason: 'Registered twice at the front desk',
    });

    // One open request per record; the same pair or either record again is refused.
    expect((await ask(dup.id, kept.id)).statusCode).toBe(409);
    expect((await ask(clinics.a.patients[1]!.id, dup.id)).json().error.fields).toEqual({
      merge: 'pending',
    });
    expect((await ask(kept.id, kept.id)).statusCode).toBe(400);

    // Both records show the request on their page.
    const page = PatientDetail.parse((await call('GET', `/patients/${kept.id}`, desk)).json());
    expect(page.pendingMerge).toMatchObject({ id: created.id, source: { id: dup.id } });

    const list = PatientMergeList.parse((await call('GET', '/patient-merges', adminA)).json());
    expect(list.data.map((r) => r.id)).toEqual([created.id]);
    expect((await call('GET', '/patient-merges', desk)).statusCode).toBe(403);
    expect((await call('POST', `/patient-merges/${created.id}/approve`, desk, {})).statusCode).toBe(
      403,
    );
    expect(await h.owner.auditLog.count({ where: { action: 'patient_merge.requested' } })).toBe(1);
  });

  it('stay inside the clinic', async () => {
    const { kept, dup } = await duplicateWithHistory();
    const adminB = await staffLogin(h, 'clinic-b', clinics.b.admin);
    expect((await ask(dup.id, kept.id, adminB)).statusCode).toBe(400);
    expect((await ask(clinics.b.patients[0]!.id, kept.id, adminB)).statusCode).toBe(400);
    const created = PatientMergeRequest.parse((await ask(dup.id, kept.id)).json());
    expect(
      PatientMergeList.parse((await call('GET', '/patient-merges', adminB)).json()).data,
    ).toEqual([]);
    expect(
      (await call('POST', `/patient-merges/${created.id}/approve`, adminB, {})).statusCode,
    ).toBe(404);
  });

  it('can be rejected with a reason, keeping both records', async () => {
    const { kept, dup } = await duplicateWithHistory();
    const created = PatientMergeRequest.parse((await ask(dup.id, kept.id)).json());
    expect(
      (await call('POST', `/patient-merges/${created.id}/reject`, adminA, {})).statusCode,
    ).toBe(400);
    const res = await call('POST', `/patient-merges/${created.id}/reject`, adminA, {
      note: 'Different people: mother and daughter',
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(PatientMergeRequest.parse(res.json())).toMatchObject({
      status: 'rejected',
      decisionNote: 'Different people: mother and daughter',
    });
    expect(
      (await h.owner.patient.findUniqueOrThrow({ where: { id: dup.id } })).mergedIntoId,
    ).toBeNull();
    const decided = PatientMergeList.parse(
      (await call('GET', '/patient-merges?status=decided', adminA)).json(),
    );
    expect(decided.data.map((r) => r.status)).toEqual(['rejected']);
    // Decided means decided.
    expect(
      (await call('POST', `/patient-merges/${created.id}/approve`, adminA, {})).json().error.fields,
    ).toEqual({ merge: 'decided' });
  });
});

describe('approving a merge', () => {
  it('moves the living record, keeps history in place, and closes the duplicate', async () => {
    const { kept, dup, child, tag, past, upcoming } = await duplicateWithHistory();
    const created = PatientMergeRequest.parse((await ask(dup.id, kept.id)).json());
    const res = await call('POST', `/patient-merges/${created.id}/approve`, adminA, {
      note: 'Same phone and date of birth',
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(PatientMergeRequest.parse(res.json())).toMatchObject({
      status: 'approved',
      decisionNote: 'Same phone and date of birth',
    });

    // Moved: chart entries, tags, the upcoming booking, the child's guardian link.
    expect(await h.owner.allergy.count({ where: { patientId: kept.id } })).toBe(1);
    expect(await h.owner.patientTag.count({ where: { patientId: kept.id, tagId: tag.id } })).toBe(
      1,
    );
    expect(await h.owner.patientTag.count({ where: { patientId: dup.id } })).toBe(0);
    expect(
      (await h.owner.appointment.findUniqueOrThrow({ where: { id: upcoming.id } })).patientId,
    ).toBe(kept.id);
    expect(
      (await h.owner.patient.findUniqueOrThrow({ where: { id: child.id } })).guardianPatientId,
    ).toBe(kept.id);
    // Stayed: the visit and its prescription.
    expect(
      (await h.owner.appointment.findUniqueOrThrow({ where: { id: past.id } })).patientId,
    ).toBe(dup.id);

    // The duplicate points at the kept record and is read-only.
    const closed = PatientDetail.parse((await call('GET', `/patients/${dup.id}`, desk)).json());
    expect(closed.mergedInto).toEqual({ id: kept.id, uhid: kept.uhid, name: 'Asha Verma' });
    const edit = await call('PATCH', `/patients/${dup.id}`, desk, { name: 'Asha Verma' });
    expect(edit.statusCode).toBe(409);
    expect(edit.json().error).toMatchObject({
      code: 'PATIENT_MERGED',
      fields: { patientId: kept.id },
    });
    expect((await call('PUT', `/patients/${dup.id}/tags`, desk, { tagIds: [] })).statusCode).toBe(
      409,
    );
    expect(
      (
        await call('POST', `/patients/${dup.id}/allergies`, doctorA, {
          substance: 'Dust',
          source: 'doctor',
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await call('POST', '/appointments', desk, {
          walkIn: true,
          patientId: dup.id,
          doctorUserId: clinics.a.doctor.userId,
          clinicId,
          consultationTypeId: typeId,
        })
      ).json().error?.code,
    ).toBe('PATIENT_MERGED');

    // The kept record lists the duplicate; search finds the duplicate only by its old UHID.
    const keptPage = PatientDetail.parse((await call('GET', `/patients/${kept.id}`, desk)).json());
    expect(keptPage.mergedFrom).toEqual([{ id: dup.id, uhid: 'CL-000099', name: 'Asha V.' }]);
    expect(keptPage.pendingMerge).toBeNull();
    const byName = PatientListResponse.parse((await call('GET', '/patients?q=asha', desk)).json());
    expect(byName.data.map((p) => p.id)).toEqual([kept.id]);
    const byUhid = PatientListResponse.parse(
      (await call('GET', '/patients?q=cl-000099', desk)).json(),
    );
    expect(byUhid.data).toEqual([expect.objectContaining({ id: dup.id, mergedIntoId: kept.id })]);

    // History shows under the kept record: the chart, the visit list and Repeat last.
    const chart = PatientChart.parse(
      (await call('GET', `/patients/${dup.id}/chart`, doctorA)).json(),
    );
    expect(chart.patientId).toBe(kept.id);
    expect(chart.allergies.map((a) => a.substance)).toEqual(['Penicillin']);
    expect(chart.recentVisits.map((v) => v.appointmentId)).toEqual([past.id]);
    const visits = AppointmentList.parse(
      (await call('GET', `/appointments?patientId=${kept.id}`, desk)).json(),
    );
    expect(visits.data.map((a) => a.id).sort()).toEqual([past.id, upcoming.id].sort());
    const lastRes = await call('GET', `/patients/${kept.id}/last-prescription`, doctorA);
    expect(lastRes.statusCode, lastRes.body).toBe(200);
    const last = LastPrescription.parse(lastRes.json());
    expect(last.last?.items.map((i) => i.name)).toEqual(['Metformin 500']);

    expect(await h.owner.auditLog.findFirst({ where: { action: 'patient.merged' } })).toMatchObject(
      {
        entityId: created.id,
        metadata: {
          sourcePatientId: dup.id,
          targetPatientId: kept.id,
          moved: { allergies: 1, tags: 1, bookings: 1, dependants: 1 },
        },
      },
    );
  });

  it('refuses when the kept record has a guardian but the duplicate is one', async () => {
    const { kept, dup } = await duplicateWithHistory();
    const adult = clinics.a.patients[1]!;
    await h.owner.patient.update({ where: { id: kept.id }, data: { guardianPatientId: adult.id } });
    const res = await ask(dup.id, kept.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.fields).toEqual({ merge: 'guardian' });
  });

  it('is guarded in the database: nothing new may point at a merged record', async () => {
    const { kept, dup } = await duplicateWithHistory();
    const created = PatientMergeRequest.parse((await ask(dup.id, kept.id)).json());
    await call('POST', `/patient-merges/${created.id}/approve`, adminA, {});
    const CLOSED = /merged into another/;
    await expect(
      h.owner.allergy.create({
        data: {
          organisationId: clinics.a.org.id,
          patientId: dup.id,
          substance: 'Dust',
          source: 'doctor',
          recordedByUserId: clinics.a.doctor.userId,
        },
      }),
    ).rejects.toThrow(CLOSED);
    await expect(visit(dup.id, '2026-12-02T04:30:00.000Z', 'confirmed')).rejects.toThrow(CLOSED);
    await expect(
      h.owner.patient.update({ where: { id: kept.id }, data: { guardianPatientId: dup.id } }),
    ).rejects.toThrow(CLOSED);
    await expect(
      h.owner.patient.update({
        where: { id: kept.id },
        data: { mergedIntoId: kept.id, mergedAt: new Date() },
      }),
    ).rejects.toThrow(/patients_merge/);
  });
});
