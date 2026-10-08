/**
 * The safety engine through the API (PRD §6.5): checks on every save and on opening,
 * the safety log, and the doctor's answers (acknowledge, override). Drug facts come from
 * the synthetic sample (`seedSampleMedicines`), which is illustrative, not clinical data.
 */
import {
  Prescription,
  PrescriptionView,
  SafetySummary,
  type SafetyAlert,
  type TokenResponse,
} from '@dhc/contracts';
import { SAMPLE_DRUG_DATA_VERSION, seedSampleMedicines, withTenant } from '@dhc/db';
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
let doctorA: TokenResponse;
let clinicId: string;
let inPerson: string;
let video: string;

beforeEach(async () => {
  h.clock.ms = Date.UTC(2026, 9, 6, 4, 30);
  await resetDatabase(h.owner);
  await seedSampleMedicines(h.owner);
  clinics = await seedTwoClinics(h);
  doctorA = await staffLogin(h, 'clinic-a', clinics.a.doctor);
  const org = clinics.a.org.id;
  clinicId = (await h.owner.clinic.create({ data: { organisationId: org, name: 'Main clinic' } }))
    .id;
  const type = (name: string, mode: 'in_person' | 'video') =>
    h.owner.consultationType.create({
      data: { organisationId: org, name, mode, defaultDurationMin: 15, feePaise: 80000 },
    });
  inPerson = (await type('In-person consultation', 'in_person')).id;
  video = (await type('Video consultation', 'video')).id;
  // Adults unless a test says otherwise.
  await h.owner.patient.updateMany({
    where: { organisationId: org },
    data: { dob: new Date('1985-01-01T00:00:00.000Z') },
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

let token = 0;
async function visit(
  opts: {
    date?: string;
    status?: 'checked_in' | 'in_consultation' | 'completed';
    typeId?: string;
  } = {},
) {
  const date = opts.date ?? '2026-10-06';
  const startAt = new Date(`${date}T04:30:00.000Z`);
  token += 1;
  const row = await h.owner.appointment.create({
    data: {
      organisationId: clinics.a.org.id,
      patientId: clinics.a.patients[0]!.id,
      doctorUserId: clinics.a.doctor.userId,
      clinicId,
      consultationTypeId: opts.typeId ?? inPerson,
      date: new Date(`${date}T00:00:00.000Z`),
      startAt,
      endAt: new Date(startAt.getTime() + 15 * 60_000),
      status: opts.status ?? 'in_consultation',
      source: 'front_desk',
      tokenNumber: token,
      createdByUserId: clinics.a.doctor.userId,
    },
  });
  return row.id;
}

const patientId = () => clinics.a.patients[0]!.id;
const chart = {
  allergy: (substance: string, source: 'doctor' | 'patient' = 'doctor') =>
    h.owner.allergy.create({
      data: {
        organisationId: clinics.a.org.id,
        patientId: patientId(),
        substance,
        source,
        recordedByUserId: clinics.a.doctor.userId,
      },
    }),
  medication: (name: string) =>
    h.owner.currentMedication.create({
      data: {
        organisationId: clinics.a.org.id,
        patientId: patientId(),
        name,
        source: 'doctor',
        recordedByUserId: clinics.a.doctor.userId,
      },
    }),
  vitals: (appointmentId: string, data: { weightKg?: number; pregnancyStatus?: 'pregnant' }) =>
    h.owner.vitals.create({
      data: {
        organisationId: clinics.a.org.id,
        appointmentId,
        patientId: patientId(),
        recordedByUserId: clinics.a.doctor.userId,
        ...data,
      },
    }),
};

async function line(name: string, over: Record<string, unknown> = {}) {
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
    ...over,
  };
}

async function save(id: string, items: unknown[], revision = 0, tokens = doctorA) {
  const res = await call('PUT', `/appointments/${id}/prescription`, tokens, {
    language: 'en',
    items,
    revision,
  });
  return res;
}
const saved = async (id: string, items: unknown[], revision = 0) => {
  const res = await save(id, items, revision);
  expect(res.statusCode, res.body).toBe(200);
  return Prescription.parse(res.json());
};
const act = (id: string, body: Record<string, unknown>, tokens = doctorA) =>
  call('POST', `/appointments/${id}/prescription/safety-actions`, tokens, {
    reason: null,
    ...body,
  });
const alert = (rx: { safety: SafetySummary }, ruleId: string): SafetyAlert => {
  const found = rx.safety.alerts.find((a) => a.ruleId === ruleId);
  expect(found, `${ruleId} in ${rx.safety.alerts.map((a) => a.ruleId).join(', ')}`).toBeDefined();
  return found!;
};

describe('checks on save', () => {
  it('blocks a penicillin allergy with amoxicillin, which cannot be overridden', async () => {
    await chart.allergy('Penicillin');
    const id = await visit();
    const rx = await saved(id, [await line('Amoxicillin 500')]);
    const a = alert(rx, 'SR-02');
    expect(a).toMatchObject({ severity: 'block', overridable: false, unverified: false });
    expect(a.params).toMatchObject({ allergy: 'Penicillin', molecule: 'Amoxicillin' });
    expect(rx.safety).toMatchObject({
      openBlocks: 1,
      drugDatabaseVersion: SAMPLE_DRUG_DATA_VERSION,
    });

    const override = await act(id, { key: a.key, action: 'override', reason: 'Tolerated before' });
    expect(override.statusCode).toBe(400);
    expect((await act(id, { key: a.key, action: 'acknowledge' })).statusCode).toBe(400);
  });

  it('warns of warfarin with ibuprofen; acknowledging needs a reason', async () => {
    await chart.medication('Warfarin 5 mg');
    const id = await visit();
    const rx = await saved(id, [await line('Ibuprofen 400')]);
    const a = alert(rx, 'SR-05');
    expect(a).toMatchObject({ severity: 'warn', reasonRequired: true, action: null });
    expect(rx.safety.openWarnings).toBe(1);

    expect((await act(id, { key: a.key, action: 'acknowledge' })).statusCode).toBe(400);
    const res = await act(id, {
      key: a.key,
      action: 'acknowledge',
      reason: 'Short course, INR next week',
    });
    expect(res.statusCode, res.body).toBe(200);
    const summary = SafetySummary.parse(res.json());
    expect(summary.openWarnings).toBe(0);
    expect(summary.alerts.find((x) => x.key === a.key)).toMatchObject({
      action: 'acknowledged',
      reason: 'Short course, INR next week',
    });

    // The answer stays with the alert across saves while the problem is the same.
    const again = await saved(id, rx.items, rx.revision);
    expect(alert(again, 'SR-05').action).toBe('acknowledged');
    const row = await h.owner.safetyAlert.findFirstOrThrow({ where: { key: a.key } });
    expect(row).toMatchObject({
      action: 'acknowledged',
      actionByUserId: clinics.a.doctor.userId,
      drugDatabaseVersion: SAMPLE_DRUG_DATA_VERSION,
    });
    const audit = await h.owner.auditLog.findFirstOrThrow({
      where: { action: 'prescription.safety_acknowledged' },
    });
    expect(audit.metadata).toMatchObject({ ruleId: 'SR-05', alertId: row.id });
    expect(JSON.stringify(audit.metadata)).not.toContain('INR');
  });

  it('overrides a maximum-dose block with a reason; a higher dose needs a new override', async () => {
    const id = await visit();
    const over = (frequency: string) =>
      line('Paracetamol 500', {
        id: lineId,
        steps: [{ dose: '1 tablet', frequency, durationValue: 3, durationUnit: 'days' }],
      });
    const lineId = randomUUID();
    const rx = await saved(id, [await over('3-3-3')]);
    const a = alert(rx, 'SR-14');
    expect(a).toMatchObject({ severity: 'block', overridable: true, reasonRequired: true });
    expect(a.params).toMatchObject({ dailyMg: 4500, maxMg: 4000 });

    expect((await act(id, { key: a.key, action: 'override' })).statusCode).toBe(400);
    const res = await act(id, { key: a.key, action: 'override', reason: 'Specialist advice' });
    expect(SafetySummary.parse(res.json()).openBlocks).toBe(0);

    const higher = await saved(id, [await over('4-4-4')], rx.revision);
    const b = alert(higher, 'SR-14');
    expect(b.key).not.toBe(a.key);
    expect(b.action).toBeNull();
    expect(higher.safety.openBlocks).toBe(1);
  });

  it('records alerts that stop firing as changed, and reopens them if they return', async () => {
    const id = await visit();
    const free = {
      ...(await line('Paracetamol 500')),
      medicineId: null,
      name: 'Herbal tonic',
    };
    const first = await saved(id, [free]);
    const key = alert(first, 'SR-22').key;

    const second = await saved(id, [], first.revision);
    expect(second.safety.alerts).toEqual([]);
    expect(await h.owner.safetyAlert.findFirstOrThrow({ where: { key } })).toMatchObject({
      action: 'changed',
      actionByUserId: clinics.a.doctor.userId,
    });

    const third = await saved(id, [free], second.revision);
    expect(alert(third, 'SR-22').action).toBeNull();
    const row = await h.owner.safetyAlert.findFirstOrThrow({ where: { key } });
    expect(row).toMatchObject({ action: null, resolvedAt: null });
  });

  it('checks a child’s weight-based medicine again once today’s weight is recorded', async () => {
    await h.owner.patient.update({
      where: { id: patientId() },
      data: { dob: new Date('2020-05-01T00:00:00.000Z') },
    });
    const id = await visit();
    const syrup = await line('Paracetamol syrup', {
      steps: [{ dose: '5 ml', frequency: '1-1-1', durationValue: 3, durationUnit: 'days' }],
    });
    const rx = await saved(id, [syrup]);
    expect(alert(rx, 'SR-12').severity).toBe('block');

    // 15 ml × 50 mg = 750 mg/day for 20 kg = 37.5 mg/kg/day: within range.
    await chart.vitals(id, { weightKg: 20 });
    const view = PrescriptionView.parse(
      (await call('GET', `/appointments/${id}/prescription`, doctorA)).json(),
    );
    expect(view.prescription!.safety.alerts).toEqual([]);
    expect(
      await h.owner.safetyAlert.findFirstOrThrow({ where: { ruleId: 'SR-12' } }),
    ).toMatchObject({ action: 'changed' });
  });

  it('blocks a prohibited medicine in a video consultation, with no override', async () => {
    const id = await visit({ typeId: video });
    const rx = await saved(id, [await line('Tramadol + Paracetamol')]);
    const a = alert(rx, 'SR-18');
    expect(a.overridable).toBe(false);
    expect((await act(id, { key: a.key, action: 'override', reason: 'x' })).statusCode).toBe(400);
    // In person, the same line is fine.
    const clinicVisit = await visit({ date: '2026-10-07' });
    expect(
      (await saved(clinicVisit, [await line('Tramadol + Paracetamol')])).safety.alerts,
    ).toEqual([]);
  });

  it('uses pregnancy from today’s vitals, and labels patient-reported data as unverified', async () => {
    await chart.allergy('Cephalosporins', 'patient');
    const id = await visit();
    await chart.vitals(id, { pregnancyStatus: 'pregnant' });
    const rx = await saved(id, [await line('Etoricoxib 90'), await line('Cefixime 200')]);
    expect(alert(rx, 'SR-10')).toMatchObject({ severity: 'block', unverified: false });
    expect(alert(rx, 'SR-02')).toMatchObject({ unverified: true });
  });
});

describe('who may act', () => {
  it('only the visit’s doctor, on an alert that is firing now', async () => {
    await chart.medication('Warfarin 5 mg');
    const id = await visit();
    const rx = await saved(id, [await line('Ibuprofen 400')]);
    const key = alert(rx, 'SR-05').key;

    const other = await staffLogin(
      h,
      'clinic-a',
      await addStaff(h, clinics.a.org.id, 'doctor', 'second@clinic-a.test'),
    );
    expect((await act(id, { key, action: 'acknowledge', reason: 'x' }, other)).statusCode).toBe(
      403,
    );
    const doctorB = await staffLogin(h, 'clinic-b', clinics.b.doctor);
    expect((await act(id, { key, action: 'acknowledge', reason: 'x' }, doctorB)).statusCode).toBe(
      404,
    );
    // Another doctor opening the draft sees the alerts but does not write the safety log.
    const before = await h.owner.safetyAlert.findMany({ orderBy: { key: 'asc' } });
    await h.owner.allergy.create({
      data: {
        organisationId: clinics.a.org.id,
        patientId: patientId(),
        substance: 'Ibuprofen',
        source: 'doctor',
        recordedByUserId: clinics.a.doctor.userId,
      },
    });
    const seenByOther = PrescriptionView.parse(
      (await call('GET', `/appointments/${id}/prescription`, other)).json(),
    );
    expect(seenByOther.prescription!.safety.alerts.map((x) => x.ruleId)).toContain('SR-01');
    expect(await h.owner.safetyAlert.findMany({ orderBy: { key: 'asc' } })).toEqual(before);

    const gone = await act(id, { key: 'SR-05:nope', action: 'acknowledge', reason: 'x' });
    expect(gone.statusCode).toBe(409);
    expect(gone.json().error.fields).toEqual({ key: 'resolved' });

    // A clinic cannot read another clinic's safety log.
    const seen = await withTenant(h.services.db, clinics.b.org.id, (tx) => tx.safetyAlert.count());
    expect(seen).toBe(0);
  });
});
