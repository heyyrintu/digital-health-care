/**
 * The medicine master and the free-text approval queue (PRD §9.2): clinic admins add and
 * edit the clinic's own medicines, and decide each medicine doctors typed as free text.
 * Drug data is the synthetic sample, which is illustrative, not clinical data.
 */
import {
  MasterMedicine,
  MasterMedicineList,
  MedicineList,
  MedicineQueue,
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
let adminA: TokenResponse;
let doctorA: TokenResponse;
let clinicId: string;
let typeId: string;

beforeEach(async () => {
  h.clock.ms = Date.UTC(2026, 9, 6, 4, 30);
  await resetDatabase(h.owner);
  await seedSampleMedicines(h.owner);
  clinics = await seedTwoClinics(h);
  adminA = await staffLogin(h, 'clinic-a', clinics.a.admin);
  doctorA = await staffLogin(h, 'clinic-a', clinics.a.doctor);
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

const molecule = (name: string) => h.owner.drugMolecule.findUniqueOrThrow({ where: { name } });
const referenceMedicine = (name: string) =>
  h.owner.medicine.findFirstOrThrow({ where: { name, organisationId: null } });

async function newMedicine(over: Record<string, unknown> = {}) {
  const paracetamol = await molecule('Paracetamol');
  return {
    name: 'Clinic Paracetamol 650',
    genericName: 'Paracetamol',
    composition: 'Paracetamol 650 mg',
    form: 'tablet',
    defaultRoute: 'oral',
    ingredients: [{ moleculeId: paracetamol.id, strengthMg: 650, per: 'unit' }],
    ...over,
  };
}

let token = 0;
async function visit() {
  const startAt = new Date('2026-10-06T04:30:00.000Z');
  token += 1;
  return (
    await h.owner.appointment.create({
      data: {
        organisationId: clinics.a.org.id,
        patientId: clinics.a.patients[0]!.id,
        doctorUserId: clinics.a.doctor.userId,
        clinicId,
        consultationTypeId: typeId,
        date: new Date('2026-10-06T00:00:00.000Z'),
        startAt,
        endAt: new Date(startAt.getTime() + 15 * 60_000),
        status: 'in_consultation',
        source: 'front_desk',
        tokenNumber: token,
        createdByUserId: clinics.a.doctor.userId,
      },
    })
  ).id;
}

const freeText = (name: string) => ({
  id: randomUUID(),
  medicineId: null,
  name,
  composition: null,
  form: null,
  route: 'oral',
  timing: null,
  steps: [{ dose: '1 tablet', frequency: '1-0-1', durationValue: 5, durationUnit: 'days' }],
  quantity: null,
  instructions: null,
  remarks: '',
  remarksEdited: false,
});

async function prescribe(items: unknown[], tokens = doctorA) {
  const id = await visit();
  const res = await call('PUT', `/appointments/${id}/prescription`, tokens, {
    language: 'en',
    items,
    revision: 0,
  });
  expect(res.statusCode, res.body).toBe(200);
  return Prescription.parse(res.json());
}

const queue = async (tokens = adminA) => {
  const res = await call('GET', '/medicine-requests', tokens);
  expect(res.statusCode, res.body).toBe(200);
  return MedicineQueue.parse(res.json());
};
const search = async (q: string) =>
  MedicineList.parse((await call('GET', `/medicines?q=${encodeURIComponent(q)}`, doctorA)).json())
    .data;

describe('medicine master', () => {
  it('lists the reference list and the clinic’s own medicines, for clinic admins only', async () => {
    const res = await call('GET', '/medicine-master?q=paracetamol', adminA);
    expect(res.statusCode, res.body).toBe(200);
    const list = MasterMedicineList.parse(res.json());
    expect(list.data.map((m) => m.name)).toContain('Paracetamol 500');
    const p500 = list.data.find((m) => m.name === 'Paracetamol 500')!;
    expect(p500).toMatchObject({ source: 'reference', active: true });
    expect(p500.ingredients).toEqual([
      expect.objectContaining({ moleculeName: 'Paracetamol', strengthMg: 500, per: 'unit' }),
    ]);
    expect((await call('GET', '/medicine-master', doctorA)).statusCode).toBe(403);
    const molecules = await call('GET', '/drug-molecules?q=parac', adminA);
    expect(molecules.json().data.map((m: { name: string }) => m.name)).toContain('Paracetamol');
  });

  it('adds, edits and deactivates a clinic medicine; the reference list is read-only', async () => {
    const res = await call('POST', '/medicine-master', adminA, await newMedicine());
    expect(res.statusCode, res.body).toBe(201);
    const created = MasterMedicine.parse(res.json());
    expect(created).toMatchObject({ source: 'clinic', active: true });
    expect(created.ingredients[0]).toMatchObject({ moleculeName: 'Paracetamol', strengthMg: 650 });

    // Names are unique within the clinic, ignoring case.
    const dupe = await call(
      'POST',
      '/medicine-master',
      adminA,
      await newMedicine({ name: 'clinic paracetamol 650' }),
    );
    expect(dupe.statusCode).toBe(409);
    expect(dupe.json().error.fields).toEqual({ name: 'taken' });
    // A strength needs its unit; an unknown molecule is refused.
    const paracetamol = await molecule('Paracetamol');
    expect(
      (
        await call(
          'POST',
          '/medicine-master',
          adminA,
          await newMedicine({
            name: 'Odd',
            ingredients: [{ moleculeId: paracetamol.id, strengthMg: 5, per: null }],
          }),
        )
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await call(
          'POST',
          '/medicine-master',
          adminA,
          await newMedicine({
            name: 'Odd',
            ingredients: [{ moleculeId: randomUUID(), strengthMg: null, per: null }],
          }),
        )
      ).statusCode,
    ).toBe(400);

    // Doctors find it; once deactivated they no longer do.
    expect((await search('clinic para')).map((m) => m.name)).toEqual(['Clinic Paracetamol 650']);
    const off = await call('PUT', `/medicine-master/${created.id}`, adminA, {
      ...(await newMedicine({ name: 'Clinic Paracetamol 650 mg' })),
      active: false,
    });
    expect(off.statusCode, off.body).toBe(200);
    expect(MasterMedicine.parse(off.json())).toMatchObject({
      name: 'Clinic Paracetamol 650 mg',
      active: false,
    });
    expect(await search('clinic para')).toEqual([]);
    const hidden = MasterMedicineList.parse(
      (await call('GET', '/medicine-master?source=clinic', adminA)).json(),
    );
    expect(hidden.data).toEqual([]);
    const shown = MasterMedicineList.parse(
      (await call('GET', '/medicine-master?source=clinic&includeInactive=true', adminA)).json(),
    );
    expect(shown.data.map((m) => m.id)).toEqual([created.id]);

    const reference = await referenceMedicine('Paracetamol 500');
    const locked = await call('PUT', `/medicine-master/${reference.id}`, adminA, {
      ...(await newMedicine({ name: 'Hijacked' })),
      active: true,
    });
    expect(locked.statusCode).toBe(403);

    // Another clinic neither sees nor changes it.
    const adminB = await staffLogin(h, 'clinic-b', clinics.b.admin);
    const theirs = MasterMedicineList.parse(
      (await call('GET', '/medicine-master?source=clinic&includeInactive=true', adminB)).json(),
    );
    expect(theirs.data).toEqual([]);
    expect(
      (
        await call('PUT', `/medicine-master/${created.id}`, adminB, {
          ...(await newMedicine()),
          active: true,
        })
      ).statusCode,
    ).toBe(404);
    expect(await h.owner.auditLog.count({ where: { action: 'medicine.created' } })).toBe(1);
  });

  it('keeps names unique when two admins add the same name at once', async () => {
    const body = await newMedicine({ name: 'Twin Tab' });
    const codes = await Promise.all([
      call('POST', '/medicine-master', adminA, body),
      call('POST', '/medicine-master', adminA, { ...body, name: 'twin tab' }),
    ]);
    expect(codes.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect(
      await h.owner.medicine.count({
        where: { name: { equals: 'twin tab', mode: 'insensitive' } },
      }),
    ).toBe(1);
  });

  it('checks a clinic medicine with ingredients fully; without them, SR-22 says checks are limited', async () => {
    const withIngredients = MasterMedicine.parse(
      (await call('POST', '/medicine-master', adminA, await newMedicine())).json(),
    );
    const without = MasterMedicine.parse(
      (
        await call(
          'POST',
          '/medicine-master',
          adminA,
          await newMedicine({ name: 'House tonic', ingredients: [] }),
        )
      ).json(),
    );
    const line = (m: MasterMedicine) => ({
      ...freeText(m.name),
      medicineId: m.id,
      composition: m.composition,
      form: m.form,
    });
    const rx = await prescribe([line(withIngredients), line(without)]);
    const sr22 = rx.safety.alerts.filter((a) => a.ruleId === 'SR-22').map((a) => a.itemId);
    expect(sr22).toEqual([rx.items[1]!.id]);
  });
});

describe('free-text approval queue', () => {
  it('collects typed names, and maps, adds or rejects each one', async () => {
    await prescribe([freeText('Zerodol SP'), freeText('Herbal syrup')]);
    await prescribe([freeText('  zerodol   sp '), freeText('Crocin')]);

    const before = await queue();
    expect(before.pending.map((p) => [p.nameKey, p.prescriptions, p.doctors])).toEqual([
      ['zerodol sp', 2, 1],
      ['crocin', 1, 1],
      ['herbal syrup', 1, 1],
    ]);
    expect(before.decided).toEqual([]);
    expect((await call('GET', '/medicine-requests', doctorA)).statusCode).toBe(403);

    // Added as a new clinic medicine.
    const aceclofenac = await molecule('Aceclofenac');
    const added = await call('POST', '/medicine-requests/approve', adminA, {
      name: 'Zerodol SP',
      medicine: await newMedicine({
        name: 'Zerodol SP',
        genericName: 'Aceclofenac + Paracetamol + Serratiopeptidase',
        composition: 'Aceclofenac 100 mg + Paracetamol 325 mg + Serratiopeptidase 15 mg',
        ingredients: [{ moleculeId: aceclofenac.id, strengthMg: 100, per: 'unit' }],
      }),
    });
    expect(added.statusCode, added.body).toBe(201);
    expect(added.json()).toMatchObject({ decision: 'approved', medicine: { name: 'Zerodol SP' } });
    expect((await search('zerodol')).map((m) => m.name)).toEqual(['Zerodol SP']);

    // Mapped to an existing medicine: doctors find it by the name they typed.
    const p500 = await referenceMedicine('Paracetamol 500');
    expect(
      (
        await call('POST', '/medicine-requests/approve', adminA, {
          name: 'crocin',
          medicineId: p500.id,
        })
      ).statusCode,
    ).toBe(201);
    expect((await search('crocin')).map((m) => m.name)).toEqual(['Paracetamol 500']);

    // Rejected with a reason; a second decision on the same name is refused.
    const rejected = await call('POST', '/medicine-requests/reject', adminA, {
      name: 'Herbal Syrup',
      reason: 'Not a licensed medicine',
    });
    expect(rejected.statusCode, rejected.body).toBe(201);
    const again = await call('POST', '/medicine-requests/reject', adminA, {
      name: 'herbal syrup',
      reason: 'Twice',
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.fields).toEqual({ name: 'decided' });

    const after = await queue();
    expect(after.pending).toEqual([]);
    expect(
      after.decided.map((d) => [d.nameKey, d.decision, d.medicine?.name ?? null, d.prescriptions]),
    ).toEqual(
      expect.arrayContaining([
        ['zerodol sp', 'approved', 'Zerodol SP', 2],
        ['crocin', 'approved', 'Paracetamol 500', 1],
        ['herbal syrup', 'rejected', null, 1],
      ]),
    );

    // Undo puts the name back in the queue.
    const herbal = after.decided.find((d) => d.nameKey === 'herbal syrup')!;
    expect((await call('DELETE', `/medicine-requests/${herbal.id}`, adminA)).statusCode).toBe(204);
    expect((await queue()).pending.map((p) => p.nameKey)).toEqual(['herbal syrup']);

    // Prescriptions already written keep their free-text lines.
    expect(await h.owner.prescriptionItem.count({ where: { medicineId: null } })).toBe(4);
    expect(
      await h.owner.auditLog.count({
        where: {
          action: {
            in: [
              'medicine_request.approved',
              'medicine_request.rejected',
              'medicine_request.undone',
            ],
          },
        },
      }),
    ).toBe(4);
  });

  it('refuses an inactive medicine, and keeps each clinic’s queue to itself', async () => {
    await prescribe([freeText('Dolo')]);
    const created = MasterMedicine.parse(
      (await call('POST', '/medicine-master', adminA, await newMedicine())).json(),
    );
    await call('PUT', `/medicine-master/${created.id}`, adminA, {
      ...(await newMedicine()),
      active: false,
    });
    const inactive = await call('POST', '/medicine-requests/approve', adminA, {
      name: 'Dolo',
      medicineId: created.id,
    });
    expect(inactive.statusCode).toBe(400);

    const adminB = await staffLogin(h, 'clinic-b', clinics.b.admin);
    expect(await queue(adminB)).toEqual({ pending: [], decided: [] });
    // Clinic B cannot point its decision at clinic A's medicine.
    expect(
      (
        await call('POST', '/medicine-requests/approve', adminB, {
          name: 'Dolo',
          medicineId: created.id,
        })
      ).statusCode,
    ).toBe(400);

    const desk = await addStaff(h, clinics.a.org.id, 'front_desk', 'desk@clinic-a.test');
    expect(
      (await call('GET', '/medicine-requests', await staffLogin(h, 'clinic-a', desk))).statusCode,
    ).toBe(403);
  });

  it('guards decisions in the database too: same clinic, a key that matches, a reason', async () => {
    const org = (side: 'a' | 'b') => clinics[side].org.id;
    const own = await h.owner.medicine.create({
      data: {
        organisationId: org('a'),
        name: 'Own brand',
        genericName: 'Paracetamol',
        composition: 'Paracetamol 500 mg',
        form: 'tablet',
        defaultRoute: 'oral',
        source: 'clinic',
      },
    });
    const row = (over: Record<string, unknown>) => ({
      organisationId: org('a'),
      nameKey: 'own brand',
      name: 'Own  Brand',
      decision: 'approved' as const,
      medicineId: own.id,
      decidedByUserId: clinics.a.admin.userId,
      decidedAt: new Date(),
      ...over,
    });
    const MISMATCH = /does not match a medicines row in the same organisation/;
    // Even the owner role cannot point clinic B's decision at clinic A's medicine.
    await expect(
      h.owner.medicineRequest.create({
        data: row({ organisationId: org('b'), decidedByUserId: clinics.b.admin.userId }),
      }),
    ).rejects.toThrow(MISMATCH);
    await expect(
      h.owner.medicineRequest.create({ data: row({ nameKey: 'other' }) }),
    ).rejects.toThrow(/medicine_requests_name_key_check/);
    await expect(
      h.owner.medicineRequest.create({
        data: row({ decision: 'rejected', medicineId: null, reason: null }),
      }),
    ).rejects.toThrow(/medicine_requests_decision_check/);
    // A platform medicine is open to every clinic.
    const reference = await referenceMedicine('Paracetamol 500');
    await h.owner.medicineRequest.create({
      data: row({
        organisationId: org('b'),
        decidedByUserId: clinics.b.admin.userId,
        medicineId: reference.id,
      }),
    });
    // A clinic medicine an approval names keeps its organisation.
    await h.owner.medicineRequest.create({ data: row({}) });
    await expect(
      h.owner.medicine.update({ where: { id: own.id }, data: { organisationId: org('b') } }),
    ).rejects.toThrow(/still referenced by medicine_requests\.medicine_id/);
  });
});
