/**
 * The clinic admin's test catalogue through the API (PRD §7.1, §9.2; API guide §3t): the
 * whole list with inactive tests, adding, editing, reordering and (de)activating, the
 * shape and size rules (in the API and the database), names unique among active tests,
 * roles and tenancy, audit, and that no edit reaches a test already ordered or blocks an
 * amendment. Personas are synthetic.
 */
import {
  AdminTestCatalogueItem,
  AdminTestCatalogueList,
  MAX_CATALOGUE_ITEMS,
  Prescription,
  TestCatalogueList,
  type TokenResponse,
} from '@dhc/contracts';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { supportVerifyDoctor } from '../src/modules/support/verify-doctor';
import {
  addStaff,
  bearer,
  createHarness,
  resetDatabase,
  seedTwoClinics,
  STAFF_PASSWORD,
  staffLogin,
} from './harness';

const h = createHarness();
let clinics: Awaited<ReturnType<typeof seedTwoClinics>>;
let adminA: TokenResponse;
let doctorA: TokenResponse;
let deskA: TokenResponse;
let adminB: TokenResponse;
let clinicId: string;
let typeId: string;
const PIN = '482916';
const source = { id: 'test-run', ip: 'test', headers: { 'user-agent': 'test' } };

beforeEach(async () => {
  h.clock.ms = Date.UTC(2026, 9, 6, 4, 30);
  await resetDatabase(h.owner);
  clinics = await seedTwoClinics(h);
  adminA = await staffLogin(h, 'clinic-a', clinics.a.admin);
  doctorA = await staffLogin(h, 'clinic-a', clinics.a.doctor);
  deskA = await staffLogin(
    h,
    'clinic-a',
    await addStaff(h, clinics.a.org.id, 'front_desk', 'desk@clinic-a.test'),
  );
  adminB = await staffLogin(h, 'clinic-b', clinics.b.admin);
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

const adminList = async (tokens = adminA) => {
  const res = await call('GET', '/test-catalogue/items', tokens);
  expect(res.statusCode, res.body).toBe(200);
  return AdminTestCatalogueList.parse(res.json()).data;
};
const doctorList = async () =>
  TestCatalogueList.parse((await call('GET', '/test-catalogue', doctorA)).json()).data;
const named = async (name: string) => (await adminList()).find((i) => i.name === name)!;
const create = async (body: object) => {
  const res = await call('POST', '/test-catalogue/items', adminA, body);
  expect(res.statusCode, res.body).toBe(201);
  return AdminTestCatalogueItem.parse(res.json());
};
const patch = (id: string, body: object, tokens = adminA) =>
  call('PATCH', `/test-catalogue/items/${id}`, tokens, body);
const audits = (action: string) =>
  h.owner.auditLog.findMany({ where: { action }, orderBy: { at: 'asc' } });

// ---- A signed visit, as in orders.int.test.ts ------------------------------------------

let token = 0;
async function visit() {
  const startAt = new Date('2026-10-06T04:30:00.000Z');
  token += 1;
  const row = await h.owner.appointment.create({
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
  });
  return row.id;
}

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

const line = (item: { id: string; kind: string; name: string }, over: object = {}) => ({
  id: randomUUID(),
  catalogueItemId: item.id,
  kind: item.kind,
  name: item.name,
  region: null,
  side: 'na',
  views: [],
  notes: null,
  ...over,
});

const save = (id: string, tests: unknown[], revision: number) =>
  call('PUT', `/appointments/${id}/prescription`, doctorA, {
    language: 'en',
    items: [],
    revision,
    tests,
  });
const saved = async (id: string, tests: unknown[], revision = 0) => {
  const res = await save(id, tests, revision);
  expect(res.statusCode, res.body).toBe(200);
  return Prescription.parse(res.json());
};
const sign = async (id: string, rx: Prescription) => {
  const res = await call('POST', `/appointments/${id}/prescription/sign`, doctorA, {
    revision: rx.revision,
    pin: PIN,
    testIds: rx.tests.map((t) => t.id),
  });
  expect(res.statusCode, res.body).toBe(200);
  return Prescription.parse(res.json());
};

/** A signed visit ordering an MRI knee, right and a CBC; returns the orders. */
async function ordered() {
  await readyToSign();
  const id = await visit();
  const mri = await named('MRI');
  const cbc = await named('Complete blood count (CBC)');
  const draft = await saved(id, [line(mri, { region: 'Knee', side: 'right' }), line(cbc)]);
  const rx = await sign(id, draft);
  return { visitId: id, rx, mri: rx.tests[0]!, cbc: rx.tests[1]! };
}

describe('access', () => {
  it('is for clinic admins only: other roles 403, signed out 401', async () => {
    const id = (await named('ESR')).id;
    for (const tokens of [doctorA, deskA]) {
      expect((await call('GET', '/test-catalogue/items', tokens)).statusCode).toBe(403);
      expect(
        (await call('POST', '/test-catalogue/items', tokens, { kind: 'blood', name: 'Ferritin' }))
          .statusCode,
      ).toBe(403);
      expect((await patch(id, { active: false }, tokens)).statusCode).toBe(403);
      expect(
        (
          await call('POST', '/test-catalogue/items/reorder', tokens, {
            kind: 'blood',
            ids: [id],
          })
        ).statusCode,
      ).toBe(403);
    }
    expect((await call('GET', '/test-catalogue/items', null)).statusCode).toBe(401);
    // Clinic admins still do not read the doctor's picker.
    expect((await call('GET', '/test-catalogue', adminA)).statusCode).toBe(403);
  });

  it('keeps each clinic to its own catalogue: another clinic’s tests are 404', async () => {
    const a = await adminList();
    const b = await adminList(adminB);
    expect(b.map((i) => i.name)).toEqual(a.map((i) => i.name));
    expect(b.some((i) => a.some((x) => x.id === i.id))).toBe(false);

    const ecgA = a.find((i) => i.name === 'ECG')!;
    const res = await patch(ecgA.id, { active: false }, adminB);
    expect(res.statusCode).toBe(404);
    expect((await named('ECG')).active).toBe(true);
    // Reordering with another clinic's IDs is out of date, never a write there.
    const bloodB = b.filter((i) => i.kind === 'blood').map((i) => i.id);
    const swapped = [ecgA.id, ...bloodB.slice(1)];
    const reorder = await call('POST', '/test-catalogue/items/reorder', adminB, {
      kind: 'blood',
      ids: swapped,
    });
    expect(reorder.statusCode).toBe(409);
    // A test added in one clinic is not in the other's.
    await create({ kind: 'blood', name: 'Serum ferritin' });
    expect((await adminList(adminB)).some((i) => i.name === 'Serum ferritin')).toBe(false);
  });
});

describe('editing', () => {
  it('lists every test, inactive too, in the clinic’s order', async () => {
    const all = await adminList();
    expect(all).toHaveLength(26);
    expect(all.map((i) => i.sortOrder)).toEqual(
      [...all.map((i) => i.sortOrder)].sort((x, y) => x - y),
    );
    expect(all.every((i) => i.active)).toBe(true);
    await patch(all[0]!.id, { active: false });
    const after = await adminList();
    expect(after).toHaveLength(26);
    expect(after[0]).toMatchObject({ id: all[0]!.id, active: false });
  });

  it('adds a test at the end, tidied, and audits it; a retry with the same key adds it once', async () => {
    const before = await adminList();
    const headers = { 'idempotency-key': 'add-ferritin-1' };
    const body = { kind: 'blood', name: '  Serum   ferritin ' };
    const first = await call('POST', '/test-catalogue/items', adminA, body, headers);
    expect(first.statusCode, first.body).toBe(201);
    const item = AdminTestCatalogueItem.parse(first.json());
    expect(item).toMatchObject({
      kind: 'blood',
      name: 'Serum ferritin',
      regions: [],
      views: [],
      active: true,
    });
    expect(item.sortOrder).toBeGreaterThan(Math.max(...before.map((i) => i.sortOrder)));
    const again = await call('POST', '/test-catalogue/items', adminA, body, headers);
    expect(again.statusCode).toBe(201);
    expect(again.headers['idempotent-replay']).toBe('true');
    expect(again.json().id).toBe(item.id);
    expect(await adminList()).toHaveLength(before.length + 1);

    // An X-ray with its own regions and views.
    const xray = await create({
      kind: 'xray',
      name: 'X-ray (portable)',
      regions: ['Chest', 'Abdomen'],
      views: ['AP'],
    });
    expect(xray).toMatchObject({ regions: ['Chest', 'Abdomen'], views: ['AP'] });
    // The doctor can pick it at once.
    expect((await doctorList()).map((i) => i.name)).toContain('X-ray (portable)');

    const logged = await audits('test_catalogue.created');
    expect(logged).toHaveLength(2);
    expect(logged[0]).toMatchObject({
      organisationId: clinics.a.org.id,
      actorUserId: clinics.a.admin.userId,
      entityType: 'test_catalogue_item',
      entityId: item.id,
      metadata: { kind: 'blood', regions: 0, views: 0 },
    });
  });

  it('refuses bad shapes, unknown views, long names and lists, and an empty change', async () => {
    const fields = async (body: object) => {
      const res = await call('POST', '/test-catalogue/items', adminA, body);
      expect(res.statusCode).toBe(400);
      return Object.keys(res.json().error.fields);
    };
    expect(await fields({ kind: 'blood', name: 'CBC 2', regions: ['Arm'] })).toEqual(['regions']);
    expect(await fields({ kind: 'mri', name: 'MRI 2', regions: ['Knee'], views: ['AP'] })).toEqual([
      'views',
    ]);
    expect(await fields({ kind: 'xray', name: 'X-ray 2', views: ['Frog leg'] })).toEqual([
      'views.0',
    ]);
    expect(await fields({ kind: 'xray', name: 'X-ray 2', views: ['AP', 'AP'] })).toEqual(['views']);
    expect(await fields({ kind: 'ct', name: 'CT 2', regions: ['Knee', 'KNEE'] })).toEqual([
      'regions',
    ]);
    expect(await fields({ kind: 'other', name: ' ' })).toEqual(['name']);
    expect(await fields({ kind: 'other', name: 'x'.repeat(121) })).toEqual(['name']);
    expect(await fields({ kind: 'lab', name: 'Lab' })).toEqual(['kind']);
    expect(
      await fields({
        kind: 'mri',
        name: 'MRI 2',
        regions: Array.from({ length: 41 }, (_, i) => `Region ${i}`),
      }),
    ).toEqual(['regions']);

    // Edits follow the stored kind, which never changes.
    const cbc = await named('Complete blood count (CBC)');
    const mri = await named('MRI');
    const res = await patch(cbc.id, { regions: ['Arm'] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.fields).toEqual({ regions: 'invalid' });
    expect((await patch(mri.id, { views: ['AP'] })).json().error.fields).toEqual({
      views: 'invalid',
    });
    expect((await patch(mri.id, { kind: 'ct' })).statusCode).toBe(400);
    expect((await patch(mri.id, {})).statusCode).toBe(400);
    expect((await patch(randomUUID(), { active: false })).statusCode).toBe(404);
    expect(await adminList()).toHaveLength(26);
  });

  it('keeps names unique among active tests in any case, and lets a retired name be reused', async () => {
    const esr = await named('ESR');
    const taken = await call('POST', '/test-catalogue/items', adminA, {
      kind: 'blood',
      name: 'esr',
    });
    expect(taken.statusCode).toBe(409);
    expect(taken.json().error.fields).toEqual({ name: 'taken' });
    const crp = await named('C-reactive protein (CRP)');
    expect((await patch(crp.id, { name: 'ESR' })).json().error.fields).toEqual({ name: 'taken' });

    // Retire ESR, and a new ESR may be added; the old one cannot come back beside it.
    expect((await patch(esr.id, { active: false })).statusCode).toBe(200);
    const fresh = await create({ kind: 'blood', name: 'ESR' });
    expect(fresh.id).not.toBe(esr.id);
    const back = await patch(esr.id, { active: true });
    expect(back.statusCode).toBe(409);
    expect(back.json().error.fields).toEqual({ name: 'taken' });
    // An inactive test may take an active test's name; only reactivating it would clash.
    expect((await patch(crp.id, { active: false })).statusCode).toBe(200);
    const renamed = await patch(crp.id, { name: 'esr' });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect((await patch(crp.id, { active: true })).json().error.fields).toEqual({ name: 'taken' });
    expect((await doctorList()).filter((i) => i.name === 'ESR').map((i) => i.id)).toEqual([
      fresh.id,
    ]);
  });

  it('renames and edits regions and views, auditing which fields changed', async () => {
    const xray = await named('X-ray');
    const res = await patch(xray.id, {
      name: 'X-ray (digital)',
      regions: ['Chest', 'Knee'],
      views: ['AP', 'Lateral'],
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(AdminTestCatalogueItem.parse(res.json())).toMatchObject({
      name: 'X-ray (digital)',
      regions: ['Chest', 'Knee'],
      views: ['AP', 'Lateral'],
      active: true,
    });
    // Sending what is already stored changes and audits nothing.
    expect((await patch(xray.id, { views: ['AP', 'Lateral'] })).statusCode).toBe(200);
    const updated = await audits('test_catalogue.updated');
    expect(updated).toHaveLength(1);
    expect(updated[0]).toMatchObject({
      entityType: 'test_catalogue_item',
      entityId: xray.id,
      metadata: { kind: 'xray', fields: ['name', 'regions', 'views'] },
    });
    // Never the values themselves: no names, regions or views.
    expect(JSON.stringify(updated[0]!.metadata)).not.toMatch(/X-ray|Chest|Lateral/);

    const doctor = (await doctorList()).find((i) => i.id === xray.id)!;
    expect(doctor).toMatchObject({ name: 'X-ray (digital)', regions: ['Chest', 'Knee'] });
  });

  it('deactivates and activates, auditing each, and the doctor’s list follows', async () => {
    const ecg = await named('ECG');
    const off = await patch(ecg.id, { active: false });
    expect(off.json()).toMatchObject({ active: false });
    expect((await doctorList()).some((i) => i.id === ecg.id)).toBe(false);
    expect((await call('GET', '/test-catalogue?q=ecg', doctorA)).json().data).toEqual([]);
    const on = await patch(ecg.id, { active: true });
    expect(on.json()).toMatchObject({ active: true });
    expect((await doctorList()).some((i) => i.id === ecg.id)).toBe(true);

    expect(
      (await audits('test_catalogue.deactivated')).map((a) => [a.entityId, a.metadata]),
    ).toEqual([[ecg.id, { kind: 'other' }]]);
    expect((await audits('test_catalogue.activated')).map((a) => a.entityId)).toEqual([ecg.id]);
    expect(await audits('test_catalogue.updated')).toHaveLength(0);
  });

  it('reorders one kind’s tests in the slots it had, and refuses a list that is out of date', async () => {
    const before = await adminList();
    const imaging = before.filter((i) => i.kind !== 'other' && i.kind !== 'blood');
    const other = before.filter((i) => i.kind === 'other');
    const reversed = [...other].reverse().map((i) => i.id);
    const res = await call('POST', '/test-catalogue/items/reorder', adminA, {
      kind: 'other',
      ids: reversed,
    });
    expect(res.statusCode, res.body).toBe(200);
    const after = AdminTestCatalogueList.parse(res.json()).data;
    expect(after.filter((i) => i.kind === 'other').map((i) => i.id)).toEqual(reversed);
    // The same slots, so the other kinds keep their places.
    expect(after.filter((i) => i.kind === 'other').map((i) => i.sortOrder)).toEqual(
      other.map((i) => i.sortOrder),
    );
    expect(after.filter((i) => i.kind !== 'other' && i.kind !== 'blood')).toEqual(imaging);
    expect((await doctorList()).filter((i) => i.kind === 'other').map((i) => i.id)).toEqual(
      reversed,
    );
    expect((await audits('test_catalogue.reordered'))[0]!.metadata).toEqual({
      kind: 'other',
      count: 5,
      moved: 4,
    });

    // Missing one, or with a test added since, the screen is out of date.
    const stale = await call('POST', '/test-catalogue/items/reorder', adminA, {
      kind: 'other',
      ids: reversed.slice(1),
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.fields).toEqual({ ids: 'stale' });
    const wrongKind = await call('POST', '/test-catalogue/items/reorder', adminA, {
      kind: 'blood',
      ids: reversed,
    });
    expect(wrongKind.statusCode).toBe(409);
  });

  it('holds at most the limit of tests', async () => {
    const org = clinics.a.org.id;
    await h.owner.testCatalogueItem.createMany({
      data: Array.from({ length: MAX_CATALOGUE_ITEMS - 26 }, (_, i) => ({
        organisationId: org,
        kind: 'blood' as const,
        name: `Synthetic test ${i}`,
        sortOrder: 1000 + i,
        active: false,
      })),
    });
    const res = await call('POST', '/test-catalogue/items', adminA, {
      kind: 'blood',
      name: 'One more',
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.fields).toEqual({ catalogue: 'full' });
  });

  it('lets only one of two concurrent adds take the last place', async () => {
    await h.owner.testCatalogueItem.createMany({
      data: Array.from({ length: MAX_CATALOGUE_ITEMS - 27 }, (_, i) => ({
        organisationId: clinics.a.org.id,
        kind: 'blood' as const,
        name: `Synthetic test ${i}`,
        sortOrder: 1000 + i,
        active: false,
      })),
    });
    expect(
      await h.owner.testCatalogueItem.count({ where: { organisationId: clinics.a.org.id } }),
    ).toBe(MAX_CATALOGUE_ITEMS - 1);
    const results = await Promise.all(
      ['Serum ferritin', 'Serum magnesium'].map((name) =>
        call('POST', '/test-catalogue/items', adminA, { kind: 'blood', name }),
      ),
    );
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    const refused = results.find((r) => r.statusCode === 409)!;
    expect(refused.json().error.fields).toEqual({ catalogue: 'full' });
    expect(
      await h.owner.testCatalogueItem.count({ where: { organisationId: clinics.a.org.id } }),
    ).toBe(MAX_CATALOGUE_ITEMS);
  });
});

describe('orders keep what was ordered', () => {
  it('a renamed, edited or deactivated test leaves ordered tests and amendments alone', async () => {
    const { visitId, mri, cbc } = await ordered();
    const mriItem = await named('MRI');
    const cbcItem = await named('Complete blood count (CBC)');
    // Rename the MRI and drop the knee from its regions; switch the CBC off.
    expect(
      (await patch(mriItem.id, { name: 'MRI (1.5 T)', regions: ['Brain', 'Whole spine'] }))
        .statusCode,
    ).toBe(200);
    expect((await patch(cbcItem.id, { active: false })).statusCode).toBe(200);
    expect((await doctorList()).some((i) => i.id === cbcItem.id)).toBe(false);

    const stored = await h.owner.testOrder.findMany({
      where: { appointmentId: visitId },
      orderBy: { sortOrder: 'asc' },
    });
    expect(stored.map((o) => [o.id, o.catalogueItemId, o.kind, o.name, o.region, o.side])).toEqual([
      [mri.id, mriItem.id, 'mri', 'MRI', 'Knee', 'right'],
      [cbc.id, cbcItem.id, 'blood', 'Complete blood count (CBC)', null, 'na'],
    ]);
    const listed = await call('GET', `/patients/${clinics.a.patients[0]!.id}/test-orders`, doctorA);
    expect(
      listed
        .json()
        .data.map((o: { name: string }) => o.name)
        .sort(),
    ).toEqual(['Complete blood count (CBC)', 'MRI']);

    // An amendment keeps both as they were ordered and may add a test from today's list.
    const amend = await call('POST', `/appointments/${visitId}/prescription/amend`, doctorA, {
      reason: 'Add an ESR',
    });
    expect(amend.statusCode, amend.body).toBe(201);
    const draft = Prescription.parse(amend.json());
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
    const esr = line(await named('ESR'));
    const next = await saved(visitId, [...keep, esr], draft.revision);
    expect(next.tests.map((t) => [t.id, t.name, t.region])).toEqual([
      [mri.id, 'MRI', 'Knee'],
      [cbc.id, 'Complete blood count (CBC)', null],
      [esr.id, 'ESR', null],
    ]);
    const signed = await sign(visitId, next);
    expect(signed.tests.map((t) => t.orderedAt !== null)).toEqual([true, true, true]);

    // A new order picks from today's catalogue: the old name or region is refused.
    const fresh = await visit();
    const old = await save(fresh, [line(mriItem, { region: 'Knee', side: 'left' })], 0);
    expect(old.statusCode).toBe(400);
    const renamed = await save(
      fresh,
      [line({ ...mriItem, name: 'MRI (1.5 T)' }, { region: 'Brain', side: 'na' })],
      0,
    );
    expect(renamed.statusCode, renamed.body).toBe(200);
  });
});

describe('draft tests after a catalogue edit', () => {
  it('a draft line keeps saving when only its side or notes change, after its test was renamed and narrowed', async () => {
    const id = await visit();
    const mri = await named('MRI');
    const xray = await named('X-ray');
    const mriLine = line(mri, { region: 'Knee', side: 'right' });
    const xrayLine = line(xray, { region: 'Chest', side: 'na', views: ['AP', 'Lateral'] });
    const first = await saved(id, [mriLine, xrayLine]);

    // The admin renames the MRI and drops the knee; drops Lateral from the X-ray.
    const regions = mri.regions.filter((r) => r !== 'Knee');
    expect((await patch(mri.id, { name: 'MRI (1.5 T)', regions })).statusCode).toBe(200);
    expect((await patch(xray.id, { views: ['AP', 'PA'] })).statusCode).toBe(200);

    // Notes and side only: the stored name, region and views stand.
    const notes = await saved(
      id,
      [
        { ...mriLine, notes: 'Rule out ACL tear' },
        { ...xrayLine, notes: 'Erect' },
      ],
      first.revision,
    );
    expect(notes.tests.map((t) => [t.name, t.region, t.views, t.notes])).toEqual([
      ['MRI', 'Knee', [], 'Rule out ACL tear'],
      ['X-ray', 'Chest', ['AP', 'Lateral'], 'Erect'],
    ]);
    const side = await saved(
      id,
      [
        { ...mriLine, side: 'left', notes: 'Rule out ACL tear' },
        { ...xrayLine, notes: 'Erect' },
      ],
      notes.revision,
    );
    expect(side.tests[0]).toMatchObject({ name: 'MRI', region: 'Knee', side: 'left' });

    // What changes must be valid today: a region or view no longer listed is refused, one
    // still listed is taken (the stored view that is no longer listed stays).
    const lines = (mriOver: object, xrayOver: object) => [
      { ...mriLine, side: 'left', notes: 'Rule out ACL tear', ...mriOver },
      { ...xrayLine, notes: 'Erect', ...xrayOver },
    ];
    const moved = await saved(id, lines({ region: 'Thigh' }, {}), side.revision);
    expect(moved.tests[0]!.region).toBe('Thigh');
    const back = await save(id, lines({ region: 'Knee' }, {}), moved.revision);
    expect(back.statusCode).toBe(400);
    expect(back.json().error.fields).toEqual({ tests: 'invalid' });
    const morePa = await saved(
      id,
      lines({ region: 'Thigh' }, { views: ['AP', 'PA', 'Lateral'] }),
      moved.revision,
    );
    expect(morePa.tests[1]!.views).toEqual(['AP', 'PA', 'Lateral']);
    // Picking the test again under its old name is a new choice, checked in full.
    const oldName = await save(
      id,
      [
        ...lines({ region: 'Thigh' }, { views: ['AP', 'PA', 'Lateral'] }),
        line(mri, { region: 'Brain' }),
      ],
      morePa.revision,
    );
    expect(oldName.statusCode).toBe(400);
  });
});

describe('clearing what a draft stores', () => {
  it('clears a region the test no longer lists, or from a deactivated test, and drops its views', async () => {
    const id = await visit();
    const mri = await named('MRI');
    const xray = await named('X-ray');
    const ct = await named('CT');
    const mriLine = line(mri, { region: 'Knee', side: 'right' });
    const xrayLine = line(xray, { region: 'Chest', side: 'na', views: ['AP', 'Lateral'] });
    const ctLine = line(ct, { region: 'Brain', side: 'na' });
    let rx = await saved(id, [mriLine, xrayLine, ctLine]);

    // While the test still lists regions, one is needed: clearing is refused.
    const needed = await save(id, [{ ...mriLine, region: null }, xrayLine, ctLine], rx.revision);
    expect(needed.statusCode).toBe(400);
    expect(needed.json().error.fields).toEqual({ tests: 'invalid' });

    // The MRI lists no regions now; the X-ray and the CT are deactivated.
    expect((await patch(mri.id, { regions: [] })).statusCode).toBe(200);
    expect((await patch(xray.id, { active: false })).statusCode).toBe(200);
    expect((await patch(ct.id, { active: false })).statusCode).toBe(200);
    rx = await saved(
      id,
      [
        { ...mriLine, region: null },
        { ...xrayLine, region: null, views: ['AP'] },
        { ...ctLine, region: null },
      ],
      rx.revision,
    );
    expect(rx.tests.map((t) => [t.name, t.region, t.views])).toEqual([
      ['MRI', null, []],
      ['X-ray', null, ['AP']],
      ['CT', null, []],
    ]);
    rx = await saved(
      id,
      [
        { ...mriLine, region: null },
        { ...xrayLine, region: null, views: [] },
        { ...ctLine, region: null },
      ],
      rx.revision,
    );
    expect(rx.tests[1]!.views).toEqual([]);
    // Ticking a dropped view back is a new choice: the test is no longer offered.
    const reticked = await save(
      id,
      [
        { ...mriLine, region: null },
        { ...xrayLine, region: null, views: ['Lateral'] },
        { ...ctLine, region: null },
      ],
      rx.revision,
    );
    expect(reticked.statusCode).toBe(400);

    // A new choice on a deactivated test is still refused.
    const picked = await save(
      id,
      [
        { ...mriLine, region: null },
        { ...xrayLine, region: 'Knee' },
        { ...ctLine, region: null },
      ],
      rx.revision,
    );
    expect(picked.statusCode).toBe(400);
    const viewed = await save(
      id,
      [
        { ...mriLine, region: null },
        { ...xrayLine, region: null, views: ['PA'] },
        { ...ctLine, region: null },
      ],
      rx.revision,
    );
    expect(viewed.statusCode).toBe(400);
  });
});

describe('catalogue seed', () => {
  it('re-seeding skips names held in another case or only by an inactive test', async () => {
    const org = clinics.a.org.id;
    const esr = await named('ESR');
    const ecg = await named('ECG');
    // "ESR" now held as "esr"; ECG held only by an inactive row.
    await h.owner.testCatalogueItem.update({ where: { id: esr.id }, data: { name: 'esr' } });
    await h.owner.testCatalogueItem.update({ where: { id: ecg.id }, data: { active: false } });
    const before = await h.owner.testCatalogueItem.count({ where: { organisationId: org } });
    await h.owner.$executeRaw`SELECT seed_test_catalogue(${org}::uuid)`;
    expect(await h.owner.testCatalogueItem.count({ where: { organisationId: org } })).toBe(before);
    const names = (
      await h.owner.testCatalogueItem.findMany({ where: { organisationId: org } })
    ).map((i) => i.name);
    expect(names.filter((n) => n.toLowerCase() === 'esr')).toEqual(['esr']);
    expect(names.filter((n) => n === 'ECG')).toHaveLength(1);

    // A name missing altogether is added back, once.
    await h.owner.testCatalogueItem.update({
      where: { id: (await named('HbA1c')).id },
      data: { name: 'Glycated haemoglobin' },
    });
    await h.owner.$executeRaw`SELECT seed_test_catalogue(${org}::uuid)`;
    await h.owner.$executeRaw`SELECT seed_test_catalogue(${org}::uuid)`;
    expect(
      await h.owner.testCatalogueItem.count({ where: { organisationId: org, name: 'HbA1c' } }),
    ).toBe(1);
  });
});

describe('database guard rails', () => {
  it('refuses what the API refuses even when written directly', async () => {
    const org = clinics.a.org.id;
    const add = (data: object) =>
      h.owner.testCatalogueItem.create({
        data: {
          organisationId: org,
          kind: 'xray',
          name: 'Synthetic X-ray',
          sortOrder: 900,
          ...data,
        },
      });
    /** Prisma reports a CHECK as P2039 with the constraint in the message, a unique as P2002. */
    const refused = async (data: object, constraint: string) => {
      const error = (await add(data).then(
        () => null,
        (e: unknown) => e,
      )) as { code?: string; message?: string; meta?: unknown } | null;
      expect(error, JSON.stringify(data)).not.toBeNull();
      if (constraint.endsWith('_key')) {
        expect(error!.code).toBe('P2002');
        expect(JSON.stringify(error!.meta)).toContain(constraint);
      } else {
        expect(error!.code).toBe('P2039');
        expect(error!.message).toContain(`violates check constraint "${constraint}"`);
      }
    };
    const limits = 'test_catalogue_items_limits_check';
    await refused({ views: ['Frog leg'] }, limits);
    await refused({ views: ['AP', 'AP'] }, limits);
    await refused({ regions: ['Knee', 'knee'] }, limits);
    await refused({ regions: ['x'.repeat(81)] }, limits);
    for (const region of [' Knee', 'Knee ', '\tKnee', 'Knee\n']) {
      await refused({ regions: [region] }, limits);
    }
    for (const name of [' Synthetic X-ray', 'Synthetic X-ray\t', '\nSynthetic X-ray']) {
      await refused({ name }, limits);
    }
    await refused({ name: 'x'.repeat(121) }, limits);
    await expect(add({ name: 'X'.repeat(120), active: false })).resolves.toBeDefined();
    await refused({ sortOrder: -1 }, limits);
    await refused({ kind: 'blood', regions: ['Knee'] }, 'test_catalogue_items_shape_check');
    // Active names are unique in any case; an inactive one may repeat.
    await refused({ name: 'x-RAY' }, 'test_catalogue_items_active_name_key');
    await expect(add({ name: 'X-ray', active: false })).resolves.toBeDefined();
    await expect(add({ regions: ['Knee'], views: ['AP'] })).resolves.toBeDefined();
  });
});
