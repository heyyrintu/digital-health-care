/**
 * Test orders through the API (PRD §7.1, §4.4): the seeded catalogue, tests written with
 * the prescription draft and locked by signing, the "Prescribed tests" PDF, results
 * uploaded by the front desk, the doctor and the patient within the clinic's limits, the
 * doctor's review and their list of results waiting, the chart model, and tenancy.
 * Personas and files are synthetic.
 */
import {
  AwaitingReviewList,
  PatientTestOrderList,
  PortalTestOrderList,
  Prescription,
  TestCatalogueList,
  TestOrder,
  type TestCatalogueItem,
  type TokenResponse,
  CURRENT_CONSENT_VERSIONS,
} from '@dhc/contracts';
import { seedSampleMedicines } from '@dhc/db';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { supportVerifyDoctor } from '../src/modules/support/verify-doctor';
import {
  addStaff,
  bearer,
  createHarness,
  patientLogin,
  resetDatabase,
  seedTwoClinics,
  STAFF_PASSWORD,
  staffLogin,
  type StaffFixture,
} from './harness';

const h = createHarness();
let clinics: Awaited<ReturnType<typeof seedTwoClinics>>;
let doctorA: TokenResponse;
let deskA: TokenResponse;
let doctorB: TokenResponse;
let clinicId: string;
let typeId: string;
let catalogue: TestCatalogueItem[];
const PIN = '482916';
const source = { id: 'test-run', ip: 'test', headers: { 'user-agent': 'test' } };

const PDF = Buffer.from('%PDF-1.7\n% synthetic result\n');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

beforeEach(async () => {
  h.clock.ms = Date.UTC(2026, 9, 6, 4, 30);
  await resetDatabase(h.owner);
  await seedSampleMedicines(h.owner);
  clinics = await seedTwoClinics(h);
  doctorA = await staffLogin(h, 'clinic-a', clinics.a.doctor);
  deskA = await staffLogin(
    h,
    'clinic-a',
    await addStaff(h, clinics.a.org.id, 'front_desk', 'desk@clinic-a.test'),
  );
  doctorB = await staffLogin(h, 'clinic-b', clinics.b.doctor);
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
  catalogue = TestCatalogueList.parse((await call('GET', '/test-catalogue', doctorA)).json()).data;
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

const upload = (url: string, tokens: TokenResponse, file: Buffer, type = 'application/pdf') =>
  h.app.inject({
    method: 'POST',
    url: `/v1${url}`,
    headers: { ...bearer(tokens), 'content-type': type },
    payload: file,
  });

let token = 0;
async function visit(patientId = clinics.a.patients[0]!.id, doctor = clinics.a.doctor) {
  const startAt = new Date('2026-10-06T04:30:00.000Z');
  token += 1;
  const row = await h.owner.appointment.create({
    data: {
      organisationId: clinics.a.org.id,
      patientId,
      doctorUserId: doctor.userId,
      clinicId,
      consultationTypeId: typeId,
      date: new Date('2026-10-06T00:00:00.000Z'),
      startAt,
      endAt: new Date(startAt.getTime() + 15 * 60_000),
      status: 'in_consultation',
      source: 'front_desk',
      tokenNumber: token,
      createdByUserId: doctor.userId,
    },
  });
  return row.id;
}

const item = (name: string) => catalogue.find((c) => c.name === name)!;
const mriKneeRight = (over: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  catalogueItemId: item('MRI').id,
  kind: 'mri',
  name: 'MRI',
  region: 'Knee',
  side: 'right',
  views: [],
  notes: 'Rule out ACL tear',
  ...over,
});
const xrayKnee = (over: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  catalogueItemId: item('X-ray').id,
  kind: 'xray',
  name: 'X-ray',
  region: 'Knee',
  side: 'both',
  views: ['AP', 'Lateral'],
  notes: null,
  ...over,
});
const cbc = (over: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  catalogueItemId: item('Complete blood count (CBC)').id,
  kind: 'blood',
  name: 'Complete blood count (CBC)',
  region: null,
  side: 'na',
  views: [],
  notes: null,
  ...over,
});

const save = (id: string, tests: unknown[] | undefined, revision: number, items: unknown[] = []) =>
  call('PUT', `/appointments/${id}/prescription`, doctorA, {
    language: 'en',
    items,
    revision,
    ...(tests ? { tests } : {}),
  });
const saved = async (id: string, tests: unknown[] | undefined, revision = 0) => {
  const res = await save(id, tests, revision);
  expect(res.statusCode, res.body).toBe(200);
  return Prescription.parse(res.json());
};
/** The visit's tests, as a screen showing all of them would declare them when signing. */
const visitTestIds = async (id: string) =>
  (await h.owner.testOrder.findMany({ where: { appointmentId: id }, select: { id: true } })).map(
    (t) => t.id,
  );
const signRequest = (id: string, revision: number, testIds?: string[]) =>
  call('POST', `/appointments/${id}/prescription/sign`, doctorA, {
    revision,
    pin: PIN,
    ...(testIds ? { testIds } : {}),
  });
const sign = async (id: string, revision: number) => {
  const res = await signRequest(id, revision, await visitTestIds(id));
  expect(res.statusCode, res.body).toBe(200);
  return Prescription.parse(res.json());
};

async function readyToSign() {
  await call('PUT', '/doctor-profile', doctorA, {
    registrationNumber: 'TEST-12345',
    council: 'Test Medical Council',
    qualifications: 'MBBS, MS (Ortho)',
    specialty: 'Orthopaedics',
    rxPrefix: 'sd',
    paperSize: 'a5',
  });
  const pin = await call('PUT', '/doctor-profile/signing-pin', doctorA, {
    password: STAFF_PASSWORD,
    pin: PIN,
  });
  expect(pin.statusCode, pin.body).toBe(204);
  await supportVerifyDoctor(h.services, source, {
    identifier: clinics.a.doctor.email,
    clinic: 'clinic-a',
    ticket: 'SUP-1',
    operator: 'ops@platform.test',
  });
}

/** A signed visit ordering an MRI knee, right and an X-ray; returns the orders. */
async function ordered(patientId?: string) {
  await readyToSign();
  const id = await visit(patientId);
  const draft = await saved(id, [mriKneeRight(), xrayKnee()]);
  const rx = await sign(id, draft.revision);
  return { visitId: id, rx, mri: rx.tests[0]!, xray: rx.tests[1]! };
}

const lineOfOrder = ({
  id,
  catalogueItemId,
  kind,
  name,
  region,
  side,
  views,
  notes,
}: TestOrder) => ({ id, catalogueItemId, kind, name, region, side, views, notes });

const patientOrders = async (tokens: TokenResponse, patientId = clinics.a.patients[0]!.id) => {
  const res = await call('GET', `/patients/${patientId}/test-orders`, tokens);
  expect(res.statusCode, res.body).toBe(200);
  return PatientTestOrderList.parse(res.json()).data;
};
const audits = (action: string) =>
  h.owner.auditLog.findMany({ where: { action }, orderBy: { at: 'asc' } });

describe('catalogue', () => {
  it('is seeded for every organisation, with regions for imaging and views for X-rays', async () => {
    expect(item('MRI')).toMatchObject({ kind: 'mri', views: [] });
    expect(item('MRI').regions).toContain('Knee');
    expect(item('X-ray').views).toEqual(['AP', 'PA', 'Lateral', 'Oblique', 'Skyline', 'Standing']);
    expect(item('Complete blood count (CBC)')).toMatchObject({ regions: [], views: [] });

    const search = TestCatalogueList.parse(
      (await call('GET', '/test-catalogue?q=vitamin', doctorA)).json(),
    ).data;
    expect(search.map((i) => i.name)).toEqual(['Vitamin D (25-OH)', 'Vitamin B12']);

    // Each clinic has its own rows; deactivated tests drop out.
    const b = TestCatalogueList.parse((await call('GET', '/test-catalogue', doctorB)).json()).data;
    expect(b.map((i) => i.name)).toEqual(catalogue.map((i) => i.name));
    expect(b.some((i) => catalogue.some((a) => a.id === i.id))).toBe(false);
    await h.owner.testCatalogueItem.update({
      where: { id: item('ECG').id },
      data: { active: false },
    });
    const after = TestCatalogueList.parse((await call('GET', '/test-catalogue', doctorA)).json());
    expect(after.data.some((i) => i.name === 'ECG')).toBe(false);

    expect((await call('GET', '/test-catalogue', deskA)).statusCode).toBe(403);
  });
});

describe('catalogue backfill', () => {
  it('the migration seeds organisations that existed before it, once', async () => {
    const sql = readFileSync(
      new URL(
        '../../../packages/db/prisma/migrations/20261018090000_test_orders/migration.sql',
        import.meta.url,
      ),
      'utf8',
    );
    const backfill = /^SELECT seed_test_catalogue\(id\) FROM organisations;$/m.exec(sql)?.[0];
    expect(backfill).toBeDefined();
    // An organisation from before the migration: created with the seeding trigger off.
    await h.owner.$executeRawUnsafe(
      'ALTER TABLE organisations DISABLE TRIGGER organisations_seed_test_catalogue',
    );
    const old = await h.owner.organisation
      .create({ data: { slug: 'clinic-old', name: 'Old Clinic' } })
      .finally(() =>
        h.owner.$executeRawUnsafe(
          'ALTER TABLE organisations ENABLE TRIGGER organisations_seed_test_catalogue',
        ),
      );
    const count = () => h.owner.testCatalogueItem.count({ where: { organisationId: old.id } });
    expect(await count()).toBe(0);
    await h.owner.$executeRawUnsafe(backfill!);
    expect(await count()).toBe(catalogue.length);
    // Running it again adds nothing, and leaves the other clinics' lists as they were.
    await h.owner.$executeRawUnsafe(backfill!);
    expect(await count()).toBe(catalogue.length);
    expect(
      await h.owner.testCatalogueItem.count({ where: { organisationId: clinics.a.org.id } }),
    ).toBe(catalogue.length);
  });
});

describe('ordering on the prescription draft', () => {
  it('adds, edits and removes tests with the draft, checked against the catalogue, and audits each', async () => {
    const id = await visit();
    const mri = mriKneeRight();
    const first = await saved(id, [mri, cbc()]);
    expect(first.tests.map((t) => [t.name, t.region, t.side, t.status, t.orderedAt])).toEqual([
      ['MRI', 'Knee', 'right', 'ordered', null],
      ['Complete blood count (CBC)', null, 'na', 'ordered', null],
    ]);

    // Leaving `tests` out keeps them (clients that do not know about tests yet).
    const kept = await saved(id, undefined, first.revision);
    expect(kept.tests).toHaveLength(2);

    // Edit the MRI to the left side, drop the CBC, add a free-text test.
    const free = {
      ...cbc(),
      catalogueItemId: null,
      kind: 'other',
      name: 'Synovial fluid analysis',
    };
    const second = await saved(id, [{ ...mri, side: 'left' }, free], kept.revision);
    expect(second.tests.map((t) => `${t.name}:${t.side}`)).toEqual([
      'MRI:left',
      'Synovial fluid analysis:na',
    ]);
    expect((await audits('test_order.created')).map((a) => a.entityId).sort()).toEqual(
      [mri.id, first.tests[1]!.id, free.id].sort(),
    );
    expect((await audits('test_order.updated')).map((a) => a.entityId)).toEqual([mri.id]);
    expect((await audits('test_order.deleted')).map((a) => a.entityId)).toEqual([
      first.tests[1]!.id,
    ]);
    const meta = (await audits('test_order.created'))[0]!.metadata;
    expect(JSON.stringify(meta)).not.toContain('ACL');

    // The catalogue decides regions, views and names.
    const refused = async (line: unknown) => {
      const res = await save(id, [line], second.revision);
      expect(res.statusCode, res.body).toBe(400);
      return res.json().error.fields;
    };
    expect(await refused(mriKneeRight({ region: 'Elbow joint' }))).toEqual({ tests: 'invalid' });
    expect(await refused(mriKneeRight({ region: null, side: 'na' }))).toEqual({ tests: 'invalid' });
    expect(await refused(xrayKnee({ views: ['Frog leg'] }))).toEqual({ tests: 'invalid' });
    expect(await refused(mriKneeRight({ name: 'MRI with contrast' }))).toEqual({
      tests: 'invalid',
    });
    expect(await refused({ ...cbc(), region: 'Knee' })).toHaveProperty(['tests.0.region']);
    // Another clinic's catalogue is not this clinic's.
    const bMri = TestCatalogueList.parse(
      (await call('GET', '/test-catalogue?q=MRI', doctorB)).json(),
    ).data[0]!;
    expect(await refused(mriKneeRight({ catalogueItemId: bMri.id }))).toEqual({
      tests: 'invalid',
    });
    // One ID per test, and never another visit's.
    const twice = await save(id, [mri, mri], second.revision);
    expect(twice.json().error.fields).toEqual({ tests: 'invalid' });
    const other = await visit(clinics.a.patients[1]!.id);
    const taken = await call('PUT', `/appointments/${other}/prescription`, doctorA, {
      language: 'en',
      items: [],
      revision: 0,
      tests: [mri],
    });
    expect(taken.statusCode).toBe(400);
    expect(taken.json().error.fields).toEqual({ tests: 'invalid' });
  });

  it('only the visit’s doctor writes tests, and other roles cannot', async () => {
    const id = await visit();
    const other = await staffLogin(
      h,
      'clinic-a',
      await addStaff(h, clinics.a.org.id, 'doctor', 'doctor2@clinic-a.test'),
    );
    const body = { language: 'en', items: [], revision: 0, tests: [mriKneeRight()] };
    expect((await call('PUT', `/appointments/${id}/prescription`, other, body)).statusCode).toBe(
      403,
    );
    expect((await call('PUT', `/appointments/${id}/prescription`, deskA, body)).statusCode).toBe(
      403,
    );
    expect((await call('PUT', `/appointments/${id}/prescription`, doctorB, body)).statusCode).toBe(
      404,
    );
  });
});

describe('signing orders the tests', () => {
  it('orders and locks them with the signed version; an amendment keeps them and may add more', async () => {
    const { visitId, rx, mri, xray } = await ordered();
    expect(rx.tests.map((t) => [t.status, t.orderedAt])).toEqual([
      ['ordered', rx.signedAt],
      ['ordered', rx.signedAt],
    ]);
    const rows = await h.owner.testOrder.findMany({ where: { appointmentId: visitId } });
    expect(rows.every((r) => r.prescriptionId === rx.id)).toBe(true);
    const signedAudit = (await audits('prescription.signed'))[0]!;
    expect(signedAudit.metadata).toMatchObject({ testsOrdered: 2, templateVersion: 'rx-2' });

    // Locked like the lines: the API refuses, and so does the database.
    const locked = await save(visitId, [mri], rx.revision);
    expect(locked.statusCode).toBe(409);
    expect(locked.json().error.code).toBe('PRESCRIPTION_LOCKED');
    await expect(
      h.owner.testOrder.update({ where: { id: mri.id }, data: { side: 'left' } }),
    ).rejects.toThrow(/cannot change/);
    await expect(h.owner.testOrder.delete({ where: { id: mri.id } })).rejects.toThrow(
      /cannot change/,
    );

    // The QR check still works for the signed version.
    const code = rx.verificationUrl!.split('/verify/')[1]!;
    const check = await call('POST', '/verify', null, { code });
    expect(check.json()).toMatchObject({ status: 'genuine', version: 1 });
    // The pharmacist sees the tests it printed, as printed: labels only.
    expect(check.json().tests).toEqual([
      { label: 'MRI knee, right' },
      { label: 'X-ray knee, both sides (AP, Lateral)' },
    ]);
    expect(check.body).not.toContain('ACL');

    // An amendment: the ordered tests stay as they are; a new one joins.
    const amend = await call('POST', `/appointments/${visitId}/prescription/amend`, doctorA, {
      reason: 'Add a blood test',
    });
    expect(amend.statusCode, amend.body).toBe(201);
    const draft = Prescription.parse(amend.json());
    expect(draft.tests.map((t) => t.id)).toEqual([mri.id, xray.id]);
    const strip = ({ id, catalogueItemId, kind, name, region, side, views, notes }: TestOrder) => ({
      id,
      catalogueItemId,
      kind,
      name,
      region,
      side,
      views,
      notes,
    });
    const dropped = await save(visitId, [strip(mri)], draft.revision);
    expect(dropped.statusCode).toBe(409);
    expect(dropped.json().error.fields).toEqual({ tests: 'locked' });
    const changed = await save(
      visitId,
      [{ ...strip(mri), side: 'left' }, strip(xray)],
      draft.revision,
    );
    expect(changed.json().error.fields).toEqual({ tests: 'locked' });
    const blood = cbc();
    const v2draft = await saved(visitId, [strip(mri), strip(xray), blood], draft.revision);
    expect(v2draft.tests.map((t) => [t.name, t.orderedAt !== null])).toEqual([
      ['MRI', true],
      ['X-ray', true],
      ['Complete blood count (CBC)', false],
    ]);
    const v2 = await sign(visitId, v2draft.revision);
    expect(v2.version).toBe(2);
    const after = await h.owner.testOrder.findMany({
      where: { appointmentId: visitId },
      orderBy: { sortOrder: 'asc' },
    });
    expect(after.map((o) => o.prescriptionId)).toEqual([rx.id, rx.id, v2.id]);
    const v1Check = (await call('POST', '/verify', null, { code })).json();
    expect(v1Check.status).toBe('superseded');
    // Version 1 printed two tests; version 2 three.
    expect(v1Check.tests).toHaveLength(2);
    const v2Check = await call('POST', '/verify', null, {
      code: v2.verificationUrl!.split('/verify/')[1]!,
    });
    expect(v2Check.json().tests.map((t: { label: string }) => t.label)).toEqual([
      'MRI knee, right',
      'X-ray knee, both sides (AP, Lateral)',
      'Complete blood count (CBC)',
    ]);
  });

  it('signs only the tests the doctor’s screen declared', async () => {
    await readyToSign();
    const id = await visit();
    const draft = await saved(id, [mriKneeRight(), cbc()]);
    const [mri, blood] = draft.tests;
    const refused = async (testIds?: string[]) => {
      const res = await signRequest(id, draft.revision, testIds);
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().error.fields).toEqual({ tests: 'review' });
    };
    // An older client that never shows tests: nothing declared.
    await refused();
    await refused([mri!.id]);
    await refused([mri!.id, blood!.id, randomUUID()]);
    expect(await h.owner.testOrder.count({ where: { orderedAt: { not: null } } })).toBe(0);
    expect(await h.owner.prescription.count({ where: { status: 'signed' } })).toBe(0);
    const ok = await signRequest(id, draft.revision, [blood!.id, mri!.id]);
    expect(ok.statusCode, ok.body).toBe(200);
    // Medicines alone still sign without naming any tests.
    const medsOnly = await visit(clinics.a.patients[1]!.id);
    const m = await h.owner.medicine.findFirstOrThrow({
      where: { name: { startsWith: 'Paracetamol' }, organisationId: null },
    });
    const meds = await save(medsOnly, undefined, 0, [
      {
        id: randomUUID(),
        medicineId: m.id,
        name: m.name,
        composition: m.composition,
        form: m.form,
        route: m.defaultRoute,
        timing: 'after_food',
        steps: [{ dose: '1 tablet', frequency: '1-0-1', durationValue: 3, durationUnit: 'days' }],
        quantity: null,
        instructions: null,
        remarks: '',
        remarksEdited: false,
      },
    ]);
    expect(meds.statusCode, meds.body).toBe(200);
    expect((await signRequest(medsOnly, meds.json().revision)).statusCode).toBe(200);
  });

  it('keeps an amendment saving when a catalogue test was deactivated since', async () => {
    const { visitId, mri, xray } = await ordered();
    const blood = cbc();
    // A draft line from a test the clinic then switches off stays as it is.
    await h.owner.testCatalogueItem.updateMany({
      where: { organisationId: clinics.a.org.id, name: { in: ['MRI', 'X-ray'] } },
      data: { active: false },
    });
    const draft = Prescription.parse(
      (
        await call('POST', `/appointments/${visitId}/prescription/amend`, doctorA, {
          reason: 'Add a blood test',
        })
      ).json(),
    );
    const keep = draft.tests.map(
      ({ id, catalogueItemId, kind, name, region, side, views, notes }) => ({
        id,
        catalogueItemId,
        kind,
        name,
        region,
        side,
        views,
        notes,
      }),
    );
    const next = await saved(visitId, [...keep, blood], draft.revision);
    expect(next.tests.map((t) => t.id)).toEqual([mri.id, xray.id, blood.id]);
    // An unchanged draft line too, but a changed one is checked against today's catalogue.
    await h.owner.testCatalogueItem.updateMany({
      where: { organisationId: clinics.a.org.id, name: 'Complete blood count (CBC)' },
      data: { active: false },
    });
    const again = await saved(visitId, [...keep, blood], next.revision);
    expect(again.tests).toHaveLength(3);
    const edited = await save(visitId, [...keep, { ...blood, notes: 'Fasting' }], again.revision);
    expect(edited.statusCode).toBe(400);
    expect(edited.json().error.fields).toEqual({ tests: 'invalid' });
  });

  it('lets the database order a test only through the version being signed', async () => {
    const id = await visit();
    const draft = await saved(id, [cbc()]);
    const line = draft.tests[0]!;
    const base = {
      organisationId: clinics.a.org.id,
      appointmentId: id,
      patientId: clinics.a.patients[0]!.id,
      doctorUserId: clinics.a.doctor.userId,
      kind: 'blood' as const,
      name: 'ESR',
      sortOrder: 5,
    };
    // Inserted already ordered: refused, even pointing at the visit's own prescription.
    await expect(
      h.owner.testOrder.create({
        data: {
          ...base,
          id: randomUUID(),
          orderedAt: new Date(),
          prescriptionId: draft.id,
        },
      }),
    ).rejects.toThrow(/ordered only by signing/);
    // Ordered by a draft, or with a time that is not its signature's: refused.
    await expect(
      h.owner.testOrder.update({
        where: { id: line.id },
        data: { orderedAt: new Date(), prescriptionId: draft.id },
      }),
    ).rejects.toThrow(/version being signed/);
    await readyToSign();
    const rx = await sign(id, draft.revision);
    // A draft line ordered by the signed version but not at its signing time: refused; at
    // the signing time, by the visit's newest signed version, it is what signing does.
    const late = randomUUID();
    await h.owner.testOrder.create({ data: { ...base, id: late } });
    await expect(
      h.owner.testOrder.update({
        where: { id: late },
        data: { orderedAt: new Date(Date.parse(rx.signedAt!) + 1000), prescriptionId: rx.id },
      }),
    ).rejects.toThrow(/version being signed/);
    await h.owner.testOrder.update({
      where: { id: late },
      data: { orderedAt: new Date(rx.signedAt!), prescriptionId: rx.id },
    });
    // Once an amendment exists, the older version cannot order anything.
    const amended = Prescription.parse(
      (
        await call('POST', `/appointments/${id}/prescription/amend`, doctorA, { reason: 'More' })
      ).json(),
    );
    const v2draft = await saved(id, [...amended.tests.map(lineOfOrder), cbc()], amended.revision);
    const newLine = v2draft.tests.find((t) => !t.orderedAt)!;
    await expect(
      h.owner.testOrder.update({
        where: { id: newLine.id },
        data: { orderedAt: new Date(rx.signedAt!), prescriptionId: rx.id },
      }),
    ).rejects.toThrow(/version being signed/);
    // A reviewer from another clinic is refused.
    await expect(
      h.owner.testOrder.update({
        where: { id: rx.tests[0]!.id },
        data: {
          status: 'reviewed',
          resultUploadedAt: new Date(),
          reviewedAt: new Date(),
          reviewedByUserId: clinics.b.doctor.userId,
        },
      }),
    ).rejects.toThrow(/reviewer is not a doctor/);
  });

  it('signs a prescription that orders tests only, and still needs one or the other', async () => {
    await readyToSign();
    const empty = await visit();
    const blank = await saved(empty, []);
    const refused = await call('POST', `/appointments/${empty}/prescription/sign`, doctorA, {
      revision: blank.revision,
      pin: PIN,
    });
    expect(refused.statusCode).toBe(422);

    const id = await visit(clinics.a.patients[1]!.id);
    const draft = await saved(id, [cbc()]);
    const rx = await sign(id, draft.revision);
    expect(rx.items).toEqual([]);
    expect(rx.tests[0]!.orderedAt).toBe(rx.signedAt);
    const pdf = await call('GET', `/prescriptions/${rx.id}/pdf`, deskA);
    expect(pdf.statusCode).toBe(200);
  });
});

describe('results and review', () => {
  it('front desk lists and uploads; the doctor is told, opens it and marks it reviewed', async () => {
    const { mri, xray } = await ordered();

    // The front desk sees the ordered tests, without the doctor's notes.
    const list = await patientOrders(deskA);
    expect(list.map((o) => [o.name, o.status, o.notes])).toEqual([
      ['MRI', 'ordered', null],
      ['X-ray', 'ordered', null],
    ]);
    expect(list[0]).toMatchObject({ visitDate: '2026-10-06', canReview: false });
    expect((await patientOrders(doctorA))[0]!.notes).toBe('Rule out ACL tear');
    const admin = await staffLogin(h, 'clinic-a', clinics.a.admin);
    expect(
      (await call('GET', `/patients/${clinics.a.patients[0]!.id}/test-orders`, admin)).statusCode,
    ).toBe(403);

    const up = await upload(`/test-orders/${mri.id}/results`, deskA, PDF);
    expect(up.statusCode, up.body).toBe(201);
    const after = TestOrder.parse(up.json());
    expect(after).toMatchObject({ status: 'result_uploaded', notes: null });
    expect(after.results).toEqual([
      expect.objectContaining({
        mediaType: 'application/pdf',
        sizeBytes: PDF.length,
        uploadedBy: 'clinic',
      }),
    ]);
    const [uploaded] = await audits('test_order.result_uploaded');
    expect(uploaded).toMatchObject({ entityType: 'test_order', entityId: mri.id });
    expect(uploaded!.metadata).toMatchObject({ by: 'front_desk', sizeBytes: PDF.length });
    const stored = await h.owner.testResult.findFirstOrThrow({ where: { testOrderId: mri.id } });
    expect(stored.fileKey).toMatch(
      new RegExp(`^organisations/${clinics.a.org.id}/test-results/${mri.id}-[0-9a-f]{12}\\.pdf$`),
    );

    // The front desk files results but does not open them.
    const resultId = after.results[0]!.id;
    expect((await call('GET', `/test-results/${resultId}/file`, deskA)).statusCode).toBe(403);

    // The doctor's in-app notification: results waiting for review.
    const waiting = AwaitingReviewList.parse(
      (await call('GET', '/test-orders/awaiting-review', doctorA)).json(),
    );
    expect(waiting.count).toBe(1);
    expect(waiting.data[0]).toMatchObject({
      id: mri.id,
      name: 'MRI',
      region: 'Knee',
      side: 'right',
      patient: { id: clinics.a.patients[0]!.id, name: 'Asha Verma' },
    });

    const file = await call('GET', `/test-results/${resultId}/file`, doctorA);
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('application/pdf');
    expect(file.headers['x-content-type-options']).toBe('nosniff');
    expect(file.headers['content-security-policy']).toContain('sandbox');
    expect(file.rawPayload.equals(PDF)).toBe(true);
    expect((await audits('test_result.viewed'))[0]!.metadata).toMatchObject({ resultId });

    expect((await call('POST', `/test-orders/${xray.id}/review`, doctorA)).statusCode).toBe(409);
    expect((await call('POST', `/test-orders/${mri.id}/review`, deskA)).statusCode).toBe(403);
    expect((await patientOrders(doctorA))[0]!.canReview).toBe(true);
    const reviewed = await call('POST', `/test-orders/${mri.id}/review`, doctorA);
    expect(reviewed.statusCode, reviewed.body).toBe(200);
    expect(TestOrder.parse(reviewed.json()).status).toBe('reviewed');
    expect((await call('POST', `/test-orders/${mri.id}/review`, doctorA)).statusCode).toBe(409);
    expect((await audits('test_order.reviewed')).map((a) => a.entityId)).toEqual([mri.id]);
    const listed = (await patientOrders(doctorA))[0]!;
    expect(listed).toMatchObject({ status: 'reviewed', canReview: false });
    expect(listed.reviewedAt).not.toBeNull();
    expect(
      AwaitingReviewList.parse((await call('GET', '/test-orders/awaiting-review', doctorA)).json())
        .count,
    ).toBe(0);

    // A further result opens the review again.
    const again = TestOrder.parse(
      (await upload(`/test-orders/${mri.id}/results`, doctorA, JPEG, 'image/jpeg')).json(),
    );
    expect(again).toMatchObject({ status: 'result_uploaded', reviewedAt: null });
    expect(again.results).toHaveLength(2);
    expect((await audits('test_order.result_uploaded'))[1]!.metadata).toMatchObject({
      reopened: true,
      by: 'doctor',
    });
  });

  it('follows the clinic’s upload limits and checks the file is what it says', async () => {
    const { mri } = await ordered();
    const refused = async (file: Buffer, type: string) => {
      const res = await upload(`/test-orders/${mri.id}/results`, deskA, file, type);
      return [res.statusCode, res.json().error?.fields?.file];
    };
    expect(
      await refused(Buffer.from('<html><script>alert(1)</script>'), 'application/pdf'),
    ).toEqual([400, 'type_mismatch']);
    expect(await refused(JPEG, 'application/pdf')).toEqual([400, 'type_mismatch']);
    // HEIC is not among the defaults; types no clinic may take never reach the service.
    expect(await refused(Buffer.from('....ftypheic'), 'image/heic')).toEqual([
      400,
      'type_not_allowed',
    ]);
    expect(
      (await upload(`/test-orders/${mri.id}/results`, deskA, PDF, 'text/html')).statusCode,
    ).toBe(415);
    expect(await refused(Buffer.alloc(0), 'application/pdf')).toEqual([400, 'empty']);
    await h.owner.organisationSettings.create({
      data: { organisationId: clinics.a.org.id, maxUploadMb: 1, uploadTypes: ['pdf'] },
    });
    const big = Buffer.concat([PDF, Buffer.alloc(1024 * 1024)]);
    expect(await refused(big, 'application/pdf')).toEqual([400, 'too_large']);
    expect(await refused(JPEG, 'image/jpeg')).toEqual([400, 'type_not_allowed']);
    expect(await h.owner.testResult.count()).toBe(0);
    expect((await h.owner.testOrder.findUniqueOrThrow({ where: { id: mri.id } })).status).toBe(
      'ordered',
    );

    // Draft lines are not orders yet.
    const id = await visit(clinics.a.patients[1]!.id);
    const draft = await saved(id, [cbc()]);
    const early = await upload(`/test-orders/${draft.tests[0]!.id}/results`, deskA, PDF);
    expect(early.statusCode).toBe(409);
  });

  it('authenticates an upload before reading it, and refuses one over 25 MB', async () => {
    const { mri } = await ordered();
    const body = Buffer.concat([PDF, Buffer.alloc(2 * 1024 * 1024)]);
    for (const url of [`/test-orders/${mri.id}/results`, `/portal/test-orders/${mri.id}/results`]) {
      const res = await h.app.inject({
        method: 'POST',
        url: `/v1${url}`,
        headers: { 'content-type': 'application/pdf' },
        payload: body,
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('UNAUTHENTICATED');
    }
    // A clinic admin is refused the same way (role checked before the body is read).
    const admin = await staffLogin(h, 'clinic-a', clinics.a.admin);
    expect((await upload(`/test-orders/${mri.id}/results`, admin, body)).statusCode).toBe(403);
    const huge = Buffer.concat([PDF, Buffer.alloc(25 * 1024 * 1024)]);
    expect((await upload(`/test-orders/${mri.id}/results`, deskA, huge)).statusCode).toBe(413);
    expect(await h.owner.testResult.count()).toBe(0);
  });

  it('refuses to serve a stored result that no longer matches its hash', async () => {
    const { mri } = await ordered();
    await upload(`/test-orders/${mri.id}/results`, deskA, PDF);
    const resultId = (await h.owner.testResult.findFirstOrThrow()).id;
    const get = vi.spyOn(h.services.files, 'get').mockResolvedValueOnce(Buffer.from('%PDF-x'));
    try {
      const res = await call('GET', `/test-results/${resultId}/file`, doctorA);
      expect(res.statusCode).toBe(500);
      expect(res.body).not.toContain('%PDF');
    } finally {
      get.mockRestore();
    }
    expect(await audits('test_result.viewed')).toEqual([]);
  });

  it('removes the stored file when the result cannot be recorded', async () => {
    const { mri } = await ordered();
    const leaver = await addStaff(h, clinics.a.org.id, 'front_desk', 'leaver@clinic-a.test');
    const tokens = await staffLogin(h, 'clinic-a', leaver);
    // Still signed in, but no longer on the staff list: the database refuses the result row.
    await h.owner.membership.deleteMany({ where: { userId: leaver.userId } });
    const put = vi.spyOn(h.services.files, 'put');
    const remove = vi.spyOn(h.services.files, 'delete');
    try {
      const res = await upload(`/test-orders/${mri.id}/results`, tokens, PDF);
      expect(res.statusCode).toBe(500);
      const key = put.mock.calls[0]![0];
      expect(remove).toHaveBeenCalledWith(key);
      await expect(h.services.files.get(key)).rejects.toThrow();
    } finally {
      put.mockRestore();
      remove.mockRestore();
    }
    expect(await h.owner.testResult.count()).toBe(0);
    expect((await h.owner.testOrder.findUniqueOrThrow({ where: { id: mri.id } })).status).toBe(
      'ordered',
    );
  });

  it('keeps another doctor out under “own patients only”, like the chart', async () => {
    const { mri } = await ordered();
    await upload(`/test-orders/${mri.id}/results`, deskA, PDF);
    const resultId = (await h.owner.testResult.findFirstOrThrow()).id;
    await h.owner.organisationSettings.create({
      data: { organisationId: clinics.a.org.id, chartModel: 'own_patients' },
    });
    const second: StaffFixture = await addStaff(
      h,
      clinics.a.org.id,
      'doctor',
      'doc2@clinic-a.test',
    );
    const other = await staffLogin(h, 'clinic-a', second);
    const patientId = clinics.a.patients[0]!.id;
    for (const res of [
      await call('GET', `/patients/${patientId}/test-orders`, other),
      await call('GET', `/test-results/${resultId}/file`, other),
      await call('POST', `/test-orders/${mri.id}/review`, other),
    ]) {
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('CHART_RESTRICTED');
    }
    // The ordering doctor keeps access to their own order.
    expect((await call('GET', `/test-results/${resultId}/file`, doctorA)).statusCode).toBe(200);
    // Seeing the patient opens the chart, and with it the orders.
    await visit(patientId, second);
    expect((await call('GET', `/patients/${patientId}/test-orders`, other)).statusCode).toBe(200);
  });

  it('never shows or touches another clinic’s orders', async () => {
    const { mri } = await ordered();
    await upload(`/test-orders/${mri.id}/results`, deskA, PDF);
    const resultId = (await h.owner.testResult.findFirstOrThrow()).id;
    for (const res of [
      await call('GET', `/patients/${clinics.a.patients[0]!.id}/test-orders`, doctorB),
      await upload(`/test-orders/${mri.id}/results`, doctorB, PDF),
      await call('POST', `/test-orders/${mri.id}/review`, doctorB),
      await call('GET', `/test-results/${resultId}/file`, doctorB),
    ]) {
      expect(res.statusCode).toBe(404);
    }
    expect(
      AwaitingReviewList.parse((await call('GET', '/test-orders/awaiting-review', doctorB)).json()),
    ).toEqual({ count: 0, data: [] });
    // And the database refuses a result row pointing across clinics.
    await expect(
      h.owner.testResult.create({
        data: {
          organisationId: clinics.b.org.id,
          testOrderId: mri.id,
          fileKey: 'x.pdf',
          mediaType: 'application/pdf',
          sizeBytes: 1,
          sha256: '0'.repeat(64),
          uploadedByUserId: clinics.b.doctor.userId,
          uploadedByRole: 'doctor',
        },
      }),
    ).rejects.toThrow(/does not match/);
  });
});

describe('the Patient app', () => {
  const ALL = Object.entries(CURRENT_CONSENT_VERSIONS).map(([kind, version]) => ({
    kind,
    version,
  }));
  const signedUp = async (phone: string) => {
    const tokens = await patientLogin(h, 'clinic-a', phone);
    expect((await call('POST', '/portal/consents', tokens, { accept: ALL })).statusCode).toBe(200);
    return tokens;
  };

  it('lists the family’s ordered tests and uploads results only for them', async () => {
    const [asha, kamla] = clinics.a.patients;
    await h.owner.patient.update({ where: { id: asha!.id }, data: { phone: '+919000000001' } });
    await h.owner.patient.update({ where: { id: kamla!.id }, data: { phone: '+919000000002' } });
    const child = await h.owner.patient.create({
      data: {
        organisationId: clinics.a.org.id,
        uhid: 'CL-000099',
        name: 'Meera Verma',
        guardianPatientId: asha!.id,
      },
    });
    const { mri } = await ordered(asha!.id);
    const childVisit = await visit(child.id);
    const childDraft = await saved(childVisit, [cbc()]);
    const childRx = await sign(childVisit, childDraft.revision);
    const kamlaVisit = await visit(kamla!.id);
    const kamlaRx = await sign(kamlaVisit, (await saved(kamlaVisit, [cbc()])).revision);
    const kamlaOrder = kamlaRx.tests[0]!;
    // A draft test is not shown until signed.
    const draftVisit = await visit(asha!.id);
    await saved(draftVisit, [cbc()]);

    const unconsented = await patientLogin(h, 'clinic-a', '9000000001');
    const blocked = await call('GET', '/portal/test-orders', unconsented);
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe('CONSENT_REQUIRED');
    expect(
      (await upload(`/portal/test-orders/${mri.id}/results`, unconsented, PDF)).statusCode,
    ).toBe(403);

    const ashaApp = await signedUp('9000000001');
    const list = PortalTestOrderList.parse(
      (await call('GET', '/portal/test-orders', ashaApp)).json(),
    ).data;
    expect(list.map((o) => `${o.patient.name}:${o.name}`).sort()).toEqual(
      ['Asha Verma:MRI', 'Asha Verma:X-ray', 'Meera Verma:Complete blood count (CBC)'].sort(),
    );
    expect(list.find((o) => o.id === mri.id)).toMatchObject({
      region: 'Knee',
      side: 'right',
      notes: 'Rule out ACL tear',
      status: 'ordered',
    });

    // Upload for themself and for the dependant; never for someone else's family.
    const own = await upload(`/portal/test-orders/${mri.id}/results`, ashaApp, JPEG, 'image/jpeg');
    expect(own.statusCode, own.body).toBe(201);
    expect(TestOrder.parse(own.json()).results[0]!.uploadedBy).toBe('patient');
    const forChild = await upload(
      `/portal/test-orders/${childRx.tests[0]!.id}/results`,
      ashaApp,
      PDF,
    );
    expect(forChild.statusCode).toBe(201);
    const foreign = await upload(`/portal/test-orders/${kamlaOrder.id}/results`, ashaApp, PDF);
    expect(foreign.statusCode).toBe(404);
    const draftOrder = await h.owner.testOrder.findFirstOrThrow({
      where: { appointmentId: draftVisit },
    });
    expect(
      (await upload(`/portal/test-orders/${draftOrder.id}/results`, ashaApp, PDF)).statusCode,
    ).toBe(404);
    // A staff token cannot use the portal, and a patient token not the staff endpoints.
    expect((await upload(`/portal/test-orders/${mri.id}/results`, deskA, PDF)).statusCode).toBe(
      403,
    );
    expect((await upload(`/test-orders/${mri.id}/results`, ashaApp, PDF)).statusCode).toBe(403);

    const audit = (await audits('test_order.result_uploaded')).find((a) => a.entityId === mri.id);
    expect(audit).toMatchObject({ actorUserId: expect.any(String) });
    expect(audit!.metadata).toMatchObject({ by: 'patient', mediaType: 'image/jpeg' });

    // The patient opens their own results, not another family's.
    const mine = PortalTestOrderList.parse(
      (await call('GET', '/portal/test-orders', ashaApp)).json(),
    ).data.find((o) => o.id === mri.id)!;
    expect(mine.status).toBe('result_uploaded');
    const file = await call('GET', `/portal/test-results/${mine.results[0]!.id}/file`, ashaApp);
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('image/jpeg');
    expect(file.headers['x-content-type-options']).toBe('nosniff');
    expect(file.headers['content-security-policy']).toContain('sandbox');
    expect(file.headers['cache-control']).toBe('no-store');
    expect(file.headers['content-disposition']).toMatch(
      /^inline; filename="result-[0-9a-f]{8}\.jpg"$/,
    );
    expect(file.rawPayload.equals(JPEG)).toBe(true);
    // Every list view is audited under the account, like the staff list.
    const viewed = (await audits('test_orders.viewed')).filter((a) => a.entityType === 'account');
    expect(viewed.length).toBeGreaterThanOrEqual(2);
    expect(viewed[0]!.metadata).toEqual({ count: 3, source: 'patient_app' });
    const kamlaApp = await signedUp('9000000002');
    expect(
      (await call('GET', `/portal/test-results/${mine.results[0]!.id}/file`, kamlaApp)).statusCode,
    ).toBe(404);
    expect(
      PortalTestOrderList.parse(
        (await call('GET', '/portal/test-orders', kamlaApp)).json(),
      ).data.map((o) => o.id),
    ).toEqual([kamlaOrder.id]);

    // The doctor sees the patient's upload waiting for review.
    const waiting = AwaitingReviewList.parse(
      (await call('GET', '/test-orders/awaiting-review', doctorA)).json(),
    );
    expect(waiting.data.map((w) => w.id).sort()).toEqual([mri.id, childRx.tests[0]!.id].sort());
  });
});

describe('merged records', () => {
  it('shows a duplicate’s orders under the record that was kept, for staff and the patient', async () => {
    const [kept, duplicate] = clinics.a.patients;
    await h.owner.patient.update({ where: { id: kept!.id }, data: { phone: '+919000000001' } });
    const { mri } = await ordered(duplicate!.id);
    // As an approved merge leaves it: the duplicate points at the kept record.
    await h.owner.patient.update({
      where: { id: duplicate!.id },
      data: { mergedIntoId: kept!.id, mergedAt: new Date() },
    });
    expect((await patientOrders(doctorA, kept!.id)).map((o) => o.id)).toEqual([
      mri.id,
      expect.any(String),
    ]);
    expect((await patientOrders(deskA, duplicate!.id)).map((o) => o.id)).toContain(mri.id);

    const tokens = await patientLogin(h, 'clinic-a', '9000000001');
    const ALL = Object.entries(CURRENT_CONSENT_VERSIONS).map(([kind, version]) => ({
      kind,
      version,
    }));
    await call('POST', '/portal/consents', tokens, { accept: ALL });
    const list = PortalTestOrderList.parse(
      (await call('GET', '/portal/test-orders', tokens)).json(),
    ).data;
    expect(list.map((o) => [o.name, o.patient.id])).toEqual([
      ['MRI', kept!.id],
      ['X-ray', kept!.id],
    ]);
    const up = await upload(`/portal/test-orders/${mri.id}/results`, tokens, PDF);
    expect(up.statusCode, up.body).toBe(201);
  });
});
