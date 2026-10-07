import {
  LastPrescription,
  MedicineList,
  Prescription,
  PrescriptionTemplateList,
  PrescriptionView,
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
let doctorA: TokenResponse;
let desk: TokenResponse;
let clinicId: string;
let typeId: string;

beforeEach(async () => {
  h.clock.ms = Date.UTC(2026, 9, 6, 4, 30);
  await resetDatabase(h.owner);
  await seedSampleMedicines(h.owner);
  clinics = await seedTwoClinics(h);
  const frontDesk = await addStaff(h, clinics.a.org.id, 'front_desk', 'desk@clinic-a.test');
  doctorA = await staffLogin(h, 'clinic-a', clinics.a.doctor);
  desk = await staffLogin(h, 'clinic-a', frontDesk);
  const org = clinics.a.org.id;
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

let token = 0;
/** A visit for a clinic A patient on `date`, straight into the database. */
async function visit(
  date = '2026-10-06',
  status: 'confirmed' | 'checked_in' | 'in_consultation' | 'completed' = 'in_consultation',
  patient = 0,
) {
  const startAt = new Date(`${date}T04:30:00.000Z`);
  token += 1;
  const row = await h.owner.appointment.create({
    data: {
      organisationId: clinics.a.org.id,
      patientId: clinics.a.patients[patient]!.id,
      doctorUserId: clinics.a.doctor.userId,
      clinicId,
      consultationTypeId: typeId,
      date: new Date(`${date}T00:00:00.000Z`),
      startAt,
      endAt: new Date(startAt.getTime() + 15 * 60_000),
      status,
      source: 'front_desk',
      tokenNumber: token,
      createdByUserId: clinics.a.doctor.userId,
    },
  });
  return row.id;
}

async function medicine(name: string) {
  const m = await h.owner.medicine.findFirstOrThrow({ where: { name, organisationId: null } });
  return m;
}

async function line(name: string, over: Record<string, unknown> = {}) {
  const m = await medicine(name);
  return {
    id: randomUUID(),
    medicineId: m.id,
    name: m.name,
    composition: m.composition,
    form: m.form,
    route: m.defaultRoute,
    timing: 'after_food',
    steps: [{ dose: '1 tablet', frequency: '1-0-1', durationValue: 5, durationUnit: 'days' }],
    quantity: '10 tablets',
    instructions: null,
    remarks: '',
    remarksEdited: false,
    ...over,
  };
}

const save = (id: string, items: unknown[], revision: number, language = 'en', tokens = doctorA) =>
  call('PUT', `/appointments/${id}/prescription`, tokens, { language, items, revision });

describe('medicine search', () => {
  it('finds by name, generic or composition, for doctors only', async () => {
    const res = await call('GET', '/medicines?q=parac', doctorA);
    expect(res.statusCode, res.body).toBe(200);
    const names = MedicineList.parse(res.json()).data.map((m) => m.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'Paracetamol 650',
        'Aceclofenac + Paracetamol',
        'Tramadol + Paracetamol',
      ]),
    );
    expect(
      MedicineList.parse((await call('GET', '/medicines?q=clavulanic', doctorA)).json()).data[0]
        ?.name,
    ).toBe('Amoxicillin + Clavulanic acid 625');
    expect((await call('GET', '/medicines?q=p', doctorA)).statusCode).toBe(400);
    expect((await call('GET', '/medicines?q=parac', desk)).statusCode).toBe(403);
  });

  it('shows the platform master and the clinic’s own medicines, not other clinics’', async () => {
    await h.owner.medicine.create({
      data: {
        organisationId: clinics.b.org.id,
        name: 'Clinic B knee oil',
        genericName: 'Herbal',
        composition: 'Herbal oil',
        form: 'oil',
        source: 'clinic',
        defaultRoute: 'topical',
      },
    });
    const a = MedicineList.parse((await call('GET', '/medicines?q=knee', doctorA)).json()).data;
    expect(a).toEqual([]);
    const doctorB = await staffLogin(h, 'clinic-b', clinics.b.doctor);
    const b = MedicineList.parse((await call('GET', '/medicines?q=knee', doctorB)).json()).data;
    expect(b.map((m) => m.source)).toEqual(['clinic']);
  });
});

describe('prescription drafts', () => {
  it('saves lines with remarks written by the server, and rejects a stale tab', async () => {
    const id = await visit();
    const empty = PrescriptionView.parse(
      (await call('GET', `/appointments/${id}/prescription`, doctorA)).json(),
    );
    expect(empty).toMatchObject({ prescription: null, canEdit: true, defaultLanguage: 'en' });

    const para = await line('Paracetamol 650');
    const gel = await line('Diclofenac gel', {
      timing: null,
      steps: [{ dose: 'a thin layer', frequency: 'TDS', durationValue: 7, durationUnit: 'days' }],
    });
    const free = {
      ...(await line('Paracetamol 650')),
      id: randomUUID(),
      medicineId: null,
      name: 'Knee cap support',
      composition: null,
      form: null,
      route: 'other',
      timing: null,
      steps: [{ dose: '1', frequency: 'daytime', durationValue: 4, durationUnit: 'weeks' }],
      remarks: 'Wear during the day; remove at night.',
      remarksEdited: true,
    };
    const first = await save(id, [para, gel, free], 0);
    expect(first.statusCode, first.body).toBe(200);
    const saved = Prescription.parse(first.json());
    expect(saved.revision).toBe(1);
    expect(saved.items.map((i) => i.remarks)).toEqual([
      'Take 1 tablet twice a day, after breakfast and dinner, for 5 days.',
      'Apply a thin layer three times a day, for 7 days.',
      'Wear during the day; remove at night.',
    ]);
    expect(saved.items[0]!.id).toBe(para.id);

    expect((await save(id, [para], 0)).statusCode).toBe(409);

    // Hindi, and the lines' order is kept.
    const hindi = Prescription.parse((await save(id, [gel, para], 1, 'hi')).json());
    expect(hindi.revision).toBe(2);
    expect(hindi.language).toBe('hi');
    expect(hindi.items.map((i) => i.name)).toEqual(['Diclofenac gel', 'Paracetamol 650']);
    expect(hindi.items[1]!.remarks).toBe(
      '1 गोली दिन में दो बार, नाश्ते और रात के खाने के बाद, 5 दिन तक लें।',
    );

    const audit = await h.owner.auditLog.findMany({ where: { action: 'prescription.saved' } });
    expect(audit).toHaveLength(2);
    expect(JSON.stringify(audit.map((a) => a.metadata))).not.toContain('Paracetamol');
  });

  it('checks lines: unique IDs, known medicines, complete fields', async () => {
    const id = await visit();
    const para = await line('Paracetamol 650');
    expect((await save(id, [para, para], 0)).statusCode).toBe(400);
    expect((await save(id, [{ ...para, medicineId: randomUUID() }], 0)).statusCode).toBe(400);
    expect((await save(id, [{ ...para, steps: [] }], 0)).statusCode).toBe(400);
    expect((await save(id, [{ ...para, name: '' }], 0)).statusCode).toBe(400);
  });

  it('only the visit’s doctor writes, once the patient has checked in, until signing', async () => {
    const id = await visit();
    const para = await line('Paracetamol 650');
    expect((await call('GET', `/appointments/${id}/prescription`, desk)).statusCode).toBe(403);

    const other = await addStaff(h, clinics.a.org.id, 'doctor', 'second@clinic-a.test');
    const second = await staffLogin(h, 'clinic-a', other);
    const view = PrescriptionView.parse(
      (await call('GET', `/appointments/${id}/prescription`, second)).json(),
    );
    expect(view.canEdit).toBe(false);
    expect((await save(id, [para], 0, 'en', second)).statusCode).toBe(403);

    const booked = await visit('2026-10-07', 'confirmed', 1);
    expect((await save(booked, [para], 0)).statusCode).toBe(409);

    await save(id, [para], 0);
    await h.owner.consultation.create({
      data: {
        organisationId: clinics.a.org.id,
        appointmentId: id,
        patientId: clinics.a.patients[0]!.id,
        doctorUserId: clinics.a.doctor.userId,
        notesCipher: h.services.cipher.encrypt('{}'),
        lockedAt: new Date(),
      },
    });
    expect((await save(id, [para], 1)).statusCode).toBe(409);
    const locked = PrescriptionView.parse(
      (await call('GET', `/appointments/${id}/prescription`, doctorA)).json(),
    );
    expect(locked.canEdit).toBe(false);
  });

  it('uses the patient’s language by default', async () => {
    await h.owner.patient.update({
      where: { id: clinics.a.patients[1]!.id },
      data: { language: 'hi' },
    });
    const id = await visit('2026-10-06', 'checked_in', 1);
    const view = PrescriptionView.parse(
      (await call('GET', `/appointments/${id}/prescription`, doctorA)).json(),
    );
    expect(view.defaultLanguage).toBe('hi');
  });
});

describe('repeat last and templates', () => {
  it('returns the latest earlier prescription without line IDs', async () => {
    const earlier = await visit('2026-09-20', 'completed');
    const today = await visit();
    const none = LastPrescription.parse(
      (
        await call(
          'GET',
          `/patients/${clinics.a.patients[0]!.id}/last-prescription?before=${today}`,
          doctorA,
        )
      ).json(),
    );
    expect(none.last).toBeNull();

    // The earlier visit's prescription, written while it was in progress.
    await h.owner.appointment.update({
      where: { id: earlier },
      data: { status: 'in_consultation' },
    });
    await save(
      earlier,
      [
        await line('Etoricoxib 90', {
          steps: [{ dose: '1 tablet', frequency: 'OD', durationValue: 10, durationUnit: 'days' }],
        }),
      ],
      0,
    );
    await h.owner.appointment.update({ where: { id: earlier }, data: { status: 'completed' } });

    const res = await call(
      'GET',
      `/patients/${clinics.a.patients[0]!.id}/last-prescription?before=${today}`,
      doctorA,
    );
    const last = LastPrescription.parse(res.json()).last!;
    expect(last).toMatchObject({ appointmentId: earlier, date: '2026-09-20' });
    expect(last.items).toHaveLength(1);
    expect(last.items[0]).not.toHaveProperty('id');
    expect(last.items[0]!.remarks).toBe('Take 1 tablet once a day, after food, for 10 days.');
    expect(
      (await call('GET', `/patients/${clinics.a.patients[0]!.id}/last-prescription`, desk))
        .statusCode,
    ).toBe(403);
  });

  it('never offers a later visit’s prescription when writing an older visit', async () => {
    const older = await visit('2026-09-20', 'in_consultation');
    const later = await visit('2026-10-06', 'in_consultation');
    await save(later, [await line('Etoricoxib 90')], 0);
    const patientId = clinics.a.patients[0]!.id;
    const fromOlder = LastPrescription.parse(
      (
        await call('GET', `/patients/${patientId}/last-prescription?before=${older}`, doctorA)
      ).json(),
    );
    expect(fromOlder.last).toBeNull();
    const anyVisit = LastPrescription.parse(
      (await call('GET', `/patients/${patientId}/last-prescription`, doctorA)).json(),
    );
    expect(anyVisit.last?.appointmentId).toBe(later);
    // A visit of another patient is not a valid reference point.
    const otherPatientVisit = await visit('2026-10-06', 'checked_in', 1);
    expect(
      (
        await call(
          'GET',
          `/patients/${patientId}/last-prescription?before=${otherPatientVisit}`,
          doctorA,
        )
      ).statusCode,
    ).toBe(404);
  });

  it('keeps each doctor’s templates; saving the same name replaces it', async () => {
    const { id: _a, ...para } = await line('Paracetamol 650');
    const { id: _b, ...ppi } = await line('Pantoprazole 40', {
      timing: 'before_food',
      steps: [{ dose: '1 tablet', frequency: '1-0-0', durationValue: 5, durationUnit: 'days' }],
    });
    const first = await call('POST', '/prescription-templates', doctorA, {
      name: 'Knee pain',
      items: [para],
    });
    expect(first.statusCode, first.body).toBe(201);
    const replaced = await call('POST', '/prescription-templates', doctorA, {
      name: 'Knee pain',
      items: [para, ppi],
    });
    expect(replaced.json().id).toBe(first.json().id);

    const list = PrescriptionTemplateList.parse(
      (await call('GET', '/prescription-templates', doctorA)).json(),
    );
    expect(list.data).toHaveLength(1);
    expect(list.data[0]!.items.map((i) => i.name)).toEqual(['Paracetamol 650', 'Pantoprazole 40']);

    const other = await addStaff(h, clinics.a.org.id, 'doctor', 'second@clinic-a.test');
    const second = await staffLogin(h, 'clinic-a', other);
    expect(
      PrescriptionTemplateList.parse((await call('GET', '/prescription-templates', second)).json())
        .data,
    ).toEqual([]);
    expect(
      (await call('DELETE', `/prescription-templates/${first.json().id}`, second)).statusCode,
    ).toBe(404);
    expect(
      (await call('DELETE', `/prescription-templates/${first.json().id}`, doctorA)).statusCode,
    ).toBe(204);
    expect(
      (await call('POST', '/prescription-templates', desk, { name: 'x', items: [para] }))
        .statusCode,
    ).toBe(403);
  });
});

describe('tenant isolation', () => {
  it('another organisation’s doctor sees none of it and cannot use its medicines', async () => {
    const id = await visit();
    const para = await line('Paracetamol 650');
    await save(id, [para], 0);
    const doctorB = await staffLogin(h, 'clinic-b', clinics.b.doctor);
    expect((await call('GET', `/appointments/${id}/prescription`, doctorB)).statusCode).toBe(404);
    expect((await save(id, [para], 1, 'en', doctorB)).statusCode).toBe(404);
    expect(
      (await call('GET', `/patients/${clinics.a.patients[0]!.id}/last-prescription`, doctorB))
        .statusCode,
    ).toBe(404);

    const clinicB = await h.owner.medicine.create({
      data: {
        organisationId: clinics.b.org.id,
        name: 'Clinic B tablet',
        genericName: 'X',
        composition: 'X 1 mg',
        form: 'tablet',
        source: 'clinic',
      },
    });
    expect(
      (await save(id, [{ ...para, id: randomUUID(), medicineId: clinicB.id }], 1)).statusCode,
    ).toBe(400);
  });
});
