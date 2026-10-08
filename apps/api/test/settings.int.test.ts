/**
 * Clinic admin settings (PRD §9.2): the chart model, safety tuning and upload limits.
 */
import {
  AuditListResponse,
  OrganisationSettings,
  Prescription,
  type TokenResponse,
} from '@dhc/contracts';
import { seedSampleMedicines } from '@dhc/db';
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
let admin: TokenResponse;
let doctor: TokenResponse;
let desk: TokenResponse;
let otherDoctor: TokenResponse;
let otherDoctorId: string;
let adminB: TokenResponse;
let clinicId: string;
let typeId: string;

beforeEach(async () => {
  h.clock.ms = Date.UTC(2026, 9, 6, 4, 30);
  await resetDatabase(h.owner);
  await seedSampleMedicines(h.owner);
  clinics = await seedTwoClinics(h);
  const org = clinics.a.org.id;
  const frontDesk = await addStaff(h, org, 'front_desk', 'desk@clinic-a.test');
  const second = await addStaff(h, org, 'doctor', 'second@clinic-a.test');
  otherDoctorId = second.userId;
  admin = await staffLogin(h, 'clinic-a', clinics.a.admin);
  doctor = await staffLogin(h, 'clinic-a', clinics.a.doctor);
  desk = await staffLogin(h, 'clinic-a', frontDesk);
  otherDoctor = await staffLogin(h, 'clinic-a', second);
  adminB = await staffLogin(h, 'clinic-b', clinics.b.admin);
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

const call = (method: string, url: string, tokens: TokenResponse | null, payload?: unknown) =>
  h.app.inject({
    method: method as 'GET',
    url: `/v1${url}`,
    headers: tokens ? bearer(tokens) : {},
    payload: payload as object,
  });

const DEFAULTS = {
  chartModel: 'shared',
  hiddenSafetyRules: [],
  maxUploadMb: 10,
  uploadTypes: ['pdf', 'jpeg', 'png'],
};

async function setSettings(over: Partial<OrganisationSettings>) {
  const res = await call('PUT', '/organisation-settings', admin, { ...DEFAULTS, ...over });
  expect(res.statusCode, res.body).toBe(200);
  return OrganisationSettings.parse(res.json());
}

const patientId = () => clinics.a.patients[0]!.id;
let token = 0;
async function visit(
  doctorUserId: string,
  status: 'confirmed' | 'checked_in' | 'in_consultation' = 'in_consultation',
) {
  const startAt = new Date('2026-10-06T04:30:00.000Z');
  token += 1;
  const row = await h.owner.appointment.create({
    data: {
      organisationId: clinics.a.org.id,
      patientId: patientId(),
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

async function line(name: string) {
  const m = await h.owner.medicine.findFirstOrThrow({ where: { name, organisationId: null } });
  return {
    id: randomUUID(),
    medicineId: m.id,
    name: m.name,
    composition: m.composition,
    form: m.form,
    route: m.defaultRoute,
    timing: 'after_food',
    steps: [{ dose: '1 tablet', frequency: '1-0-1', durationValue: 5, durationUnit: 'days' }],
    quantity: null,
    instructions: null,
    remarks: '',
    remarksEdited: false,
  };
}

describe('organisation settings', () => {
  it('starts with the defaults, which every staff role reads', async () => {
    for (const tokens of [admin, doctor, desk]) {
      const res = await call('GET', '/organisation-settings', tokens);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual(DEFAULTS);
    }
    expect((await call('GET', '/organisation-settings', null)).statusCode).toBe(401);
  });

  it('only a clinic admin changes them; each change is audited and stays in the clinic', async () => {
    const body = { ...DEFAULTS, chartModel: 'own_patients' };
    for (const tokens of [doctor, desk]) {
      expect((await call('PUT', '/organisation-settings', tokens, body)).statusCode).toBe(403);
    }
    const saved = await setSettings({
      chartModel: 'own_patients',
      hiddenSafetyRules: ['SR-15'],
      maxUploadMb: 5,
      uploadTypes: ['pdf', 'heic'],
    });
    expect(saved).toEqual({
      chartModel: 'own_patients',
      hiddenSafetyRules: ['SR-15'],
      maxUploadMb: 5,
      uploadTypes: ['pdf', 'heic'],
    });
    expect((await call('GET', '/organisation-settings', doctor)).json()).toEqual(saved);
    // Clinic B still has the defaults.
    expect((await call('GET', '/organisation-settings', adminB)).json()).toEqual(DEFAULTS);

    // Saving the same values again writes no audit entry.
    await setSettings(saved);
    const log = AuditListResponse.parse(
      (await call('GET', '/audit-log?action=settings.', admin)).json(),
    );
    expect(log.data).toHaveLength(1);
    expect(log.data[0]).toMatchObject({
      action: 'settings.updated',
      actorUserId: clinics.a.admin.userId,
    });
    const row = await h.owner.auditLog.findUniqueOrThrow({ where: { id: log.data[0]!.id } });
    expect(row.metadata).toEqual({
      chartModel: { from: 'shared', to: 'own_patients' },
      hiddenSafetyRules: { from: [], to: ['SR-15'] },
      maxUploadMb: { from: 10, to: 5 },
      uploadTypes: { from: ['pdf', 'jpeg', 'png'], to: ['pdf', 'heic'] },
    });
  });

  it('rejects critical safety rules, limits above the cap and empty or repeated lists', async () => {
    for (const bad of [
      { hiddenSafetyRules: ['SR-01'] },
      { hiddenSafetyRules: ['SR-05'] },
      { hiddenSafetyRules: ['SR-06', 'SR-06'] },
      { maxUploadMb: 26 },
      { maxUploadMb: 0 },
      { uploadTypes: [] },
      { uploadTypes: ['exe'] },
      { uploadTypes: ['pdf', 'pdf'] },
      { chartModel: 'nobody' },
    ]) {
      const res = await call('PUT', '/organisation-settings', admin, { ...DEFAULTS, ...bad });
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
    }
  });
});

describe('safety tuning', () => {
  it('hides the chosen non-critical rules from the check, and shows them again', async () => {
    // An older adult on two NSAIDs: duplicate class (SR-08) and older-adult cautions (SR-15).
    await h.owner.patient.update({
      where: { id: patientId() },
      data: { dob: new Date('1950-01-01T00:00:00.000Z') },
    });
    const id = await visit(clinics.a.doctor.userId);
    const items = [await line('Diclofenac 50'), await line('Naproxen 500')];
    const save = async (revision: number) => {
      const res = await call('PUT', `/appointments/${id}/prescription`, doctor, {
        language: 'en',
        items,
        revision,
      });
      expect(res.statusCode, res.body).toBe(200);
      return Prescription.parse(res.json());
    };
    const rules = (rx: Prescription) => new Set(rx.safety.alerts.map((a) => a.ruleId));

    const shown = await save(0);
    expect(rules(shown).has('SR-08') && rules(shown).has('SR-15')).toBe(true);

    await setSettings({ hiddenSafetyRules: ['SR-08', 'SR-15'] });
    const hidden = await save(shown.revision);
    expect(rules(hidden).has('SR-08')).toBe(false);
    expect(rules(hidden).has('SR-15')).toBe(false);
    // Hiding is not the doctor changing the prescription.
    const resolved = await h.owner.safetyAlert.findMany({
      where: { ruleId: { in: ['SR-08', 'SR-15'] } },
    });
    expect(resolved.length).toBeGreaterThan(0);
    for (const row of resolved) {
      expect(row.resolvedAt).not.toBeNull();
      expect(row.action).toBeNull();
    }

    await setSettings({ hiddenSafetyRules: [] });
    const again = await save(hidden.revision);
    expect(rules(again).has('SR-08') && rules(again).has('SR-15')).toBe(true);
  });
});

describe('chart model', () => {
  it('shared: any doctor in the clinic reads the chart', async () => {
    await visit(clinics.a.doctor.userId);
    const res = await call('GET', `/patients/${patientId()}/chart`, otherDoctor);
    expect(res.statusCode, res.body).toBe(200);
  });

  it('own patients only: a doctor needs the patient checked in to them', async () => {
    const visitId = await visit(clinics.a.doctor.userId);
    await setSettings({ chartModel: 'own_patients' });

    // The treating doctor keeps access.
    expect((await call('GET', `/patients/${patientId()}/chart`, doctor)).statusCode).toBe(200);

    const refused = [
      await call('GET', `/patients/${patientId()}/chart`, otherDoctor),
      await call('POST', `/patients/${patientId()}/allergies`, otherDoctor, {
        substance: 'Penicillin',
        source: 'doctor',
      }),
      await call('GET', `/appointments/${visitId}/consultation`, otherDoctor),
      await call('GET', `/appointments/${visitId}/prescription`, otherDoctor),
      await call('GET', `/patients/${patientId()}/last-prescription`, otherDoctor),
    ];
    for (const res of refused) {
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json().error.code).toBe('CHART_RESTRICTED');
    }

    // Front desk still records vitals; that is not the chart.
    expect((await call('GET', `/appointments/${visitId}/vitals`, desk)).statusCode).toBe(200);

    // A booking alone does not open the chart; checking in to the doctor does.
    const booked = await visit(otherDoctorId, 'confirmed');
    expect((await call('GET', `/patients/${patientId()}/chart`, otherDoctor)).statusCode).toBe(403);
    await h.owner.appointment.update({ where: { id: booked }, data: { status: 'checked_in' } });
    expect((await call('GET', `/patients/${patientId()}/chart`, otherDoctor)).statusCode).toBe(200);
    expect(
      (await call('GET', `/appointments/${visitId}/consultation`, otherDoctor)).statusCode,
    ).toBe(200);
  });
});
