import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeEach, expect, it } from 'vitest';
import { withPlatform, withTenant } from '@dhc/db';
import { type ClinicalMapping } from '@dhc/contracts';
import { importMedicineRelease } from '../src/modules/medicine-import/importer';
import {
  stageImportCatalogue,
  FILES,
  type FileName,
} from '../src/modules/medicine-staging/catalogue';
import {
  createHarness,
  resetDatabase,
  addOperator,
  platformLogin,
  bearer,
  seedTwoClinics,
  staffLogin,
} from './harness';

const h = createHarness();
let op: Awaited<ReturnType<typeof addOperator>>;
let tokens: Awaited<ReturnType<typeof platformLogin>>;
const fixture = new URL('./fixtures/cdci-synthetic/', import.meta.url);
const files = Object.fromEntries(
  Object.keys(FILES).map((f) => [f, readFileSync(new URL(f, fixture), 'utf8')]),
) as Record<FileName, string>;
const manifest = JSON.parse(readFileSync(new URL('manifest.json', fixture), 'utf8'));
const parsed = (version = 'real-fixture-1') =>
  stageImportCatalogue({ ...manifest, version, dataKind: 'real' }, files, {
    includeSourceRows: true,
  });
const options = () => ({
  operatorId: op.operatorId,
  packageSha256: 'a'.repeat(64),
  licenceTextSha256: 'b'.repeat(64),
  audit: { id: randomUUID(), ip: '127.0.0.1', headers: { 'user-agent': 'synthetic-import-test' } },
});
let sequence = 0;
const call = (method: 'GET' | 'PUT' | 'POST', path: string, payload?: unknown, auth = tokens) =>
  h.app.inject({
    method,
    url: '/v1/platform/' + path,
    headers: auth ? bearer(auth) : {},
    payload: payload as object | undefined,
    remoteAddress: `127.0.0.${++sequence}`,
  });
const importRelease = () => importMedicineRelease(h.owner, parsed(), options());
const draft = (two = false): ClinicalMapping => ({
  form: null,
  route: null,
  ingredients: (two ? ['990000000000000101', '990000000000000102'] : ['990000000000000101']).map(
    (sourceId) => ({
      sourceId,
      moleculeId: null,
      canonicalName: null,
      strengthStatus: 'unmapped',
      value: null,
      unit: null,
      per: null,
      reason: null,
    }),
  ),
  regulatoryEvidence: null,
  notes: '',
  decision: 'draft',
  reviewerName: null,
  reviewerRegistration: null,
  reviewAttested: false,
});
beforeEach(async () => {
  await resetDatabase(h.owner);
  op = await addOperator(h);
  tokens = await platformLogin(h, op);
  sequence = 0;
});
afterAll(async () => {
  await h.app.close();
  await h.owner.$disconnect();
});

it('imports all source rows, quarantines broken links and replays idempotently without touching clinical tables', async () => {
  const before = await h.owner.medicine.count();
  const imported = await importRelease();
  expect(imported).toMatchObject({
    created: true,
    brandCount: 2,
    genericCount: 2,
    sourceRows: 13,
    issueCount: 1,
    clinicalPublicationAllowed: false,
  });
  expect(await h.owner.medicineImportSourceRow.count()).toBe(13);
  expect(await h.owner.medicineImportBrand.count()).toBe(2);
  expect(
    (await h.owner.medicineImportGeneric.findMany()).every(
      (g) => g.mapping === null && g.revision === 0,
    ),
  ).toBe(true);
  const rawQuarantined = await h.owner.medicineImportSourceRow.findFirst({
    where: { file: 'BrandMaster.txt', sourceId: '990000000000000703' },
  });
  expect(rawQuarantined).not.toBeNull();
  expect((await importRelease()).created).toBe(false);
  expect(await h.owner.medicineImportRelease.count()).toBe(1);
  expect(
    await h.owner.auditLog.count({ where: { action: 'platform.medicine.import.completed' } }),
  ).toBe(1);
  expect(
    await h.owner.auditLog.count({ where: { action: 'platform.medicine.import.replayed' } }),
  ).toBe(1);
  await expect(
    importMedicineRelease(h.owner, parsed(), { ...options(), packageSha256: 'c'.repeat(64) }),
  ).rejects.toThrow('different source bytes');
  expect(await h.owner.medicine.count()).toBe(before);
  expect(await h.owner.prescription.count()).toBe(0);
});

it('lists private releases, searches exact source codes and returns source brands with a permanent publication block', async () => {
  const { releaseId } = await importRelease();
  const list = await call('GET', 'medicine-imports');
  expect(list.statusCode).toBe(200);
  expect(list.headers['cache-control']).toBe('no-store');
  expect(list.json().data[0]).toMatchObject({
    id: releaseId,
    licenceStatus: 'pending',
    clinicalPublicationAllowed: false,
    dataKind: 'real',
  });
  const generics = await call('GET', `medicine-imports/${releaseId}/generics?q=990000000000000201`);
  expect(generics.json().data).toHaveLength(1);
  expect(generics.json().data[0]).toMatchObject({ revision: 0, mapping: null });
  const brands = await call(
    'GET',
    `medicine-imports/${releaseId}/generics/990000000000000201/brands`,
  );
  expect(brands.json().data.map((b: { sourceId: string }) => b.sourceId)).toEqual([
    '990000000000000701',
  ]);
  const byBrand = await call(
    'GET',
    `medicine-imports/${releaseId}/generics?q=Synthetic%20brand%20One`,
  );
  expect(byBrand.json().data.map((g: { sourceId: string }) => g.sourceId)).toEqual([
    '990000000000000201',
  ]);
  expect((await call('GET', `medicine-imports/${randomUUID()}/generics`)).statusCode).toBe(404);
  expect((await call('GET', `medicine-imports/${releaseId}/generics/999/brands`)).statusCode).toBe(
    404,
  );
  expect((await call('POST', 'medicine-stages', parsed())).statusCode).toBe(400);
});

it('saves source-validated mappings with revision conflicts and an immutable history, without fabricating missing strengths', async () => {
  const { releaseId } = await importRelease();
  const path = `medicine-imports/${releaseId}/generics/990000000000000201`;
  const filtered = async (status: string) => {
    const response = await call('GET', `medicine-imports/${releaseId}/generics?status=${status}`);
    expect(response.statusCode, response.body).toBe(200);
    return response.json().data.map((r: { sourceId: string }) => r.sourceId);
  };
  expect(await filtered('untouched')).toHaveLength(2);
  expect(await filtered('draft')).toEqual([]);
  expect(await filtered('review_recorded')).toEqual([]);
  expect(
    (await call('GET', `medicine-imports/${releaseId}/generics?status=approved`)).statusCode,
  ).toBe(400);
  const first = await call('PUT', path + '/mapping', { revision: 0, mapping: draft() });
  expect(first.statusCode, first.body).toBe(200);
  expect(first.json().mapping.ingredients[0].value).toBeNull();
  expect(await filtered('untouched')).toHaveLength(1);
  expect(await filtered('draft')).toEqual(['990000000000000201']);
  const clinical = draft();
  clinical.form = 'Synthetic tablet';
  clinical.route = 'oral';
  clinical.ingredients[0] = {
    ...clinical.ingredients[0]!,
    canonicalName: 'Synthetic Alpha',
    strengthStatus: 'mapped',
    value: 5,
    unit: 'mg',
    per: 'unit',
  };
  clinical.regulatoryEvidence = 'Synthetic fixture evidence only, not a real clinical review';
  clinical.notes = 'Synthetic clinical test';
  clinical.decision = 'review_recorded';
  clinical.reviewerName = 'Synthetic clinician';
  clinical.reviewerRegistration = 'Synthetic council TEST-1';
  clinical.reviewAttested = true;
  expect(
    (await call('PUT', path + '/mapping', { revision: 1, mapping: clinical })).statusCode,
  ).toBe(200);
  expect(
    (await call('PUT', path + '/mapping', { revision: 1, mapping: clinical })).statusCode,
  ).toBe(409);
  expect(await filtered('draft')).toEqual([]);
  expect(await filtered('review_recorded')).toEqual(['990000000000000201']);
  const history = await call('GET', path + '/history');
  expect(history.json().data.map((r: { revision: number }) => r.revision)).toEqual([2, 1]);
  expect(history.json().data[0].mapping).toEqual(clinical);
  await expect(
    withPlatform(h.owner, (tx) => tx.medicineImportMapping.deleteMany()),
  ).rejects.toThrow(/permission denied/);
  expect(
    await h.owner.auditLog.count({ where: { action: 'platform.medicine.import.mapping.saved' } }),
  ).toBe(2);
  expect(await h.owner.medicine.count()).toBe(0);
  expect(await h.owner.prescription.count()).toBe(0);
});

it('rejects incomplete clinician review, altered ingredient identities, and inconsistent strength values', async () => {
  const { releaseId } = await importRelease();
  const path = `medicine-imports/${releaseId}/generics/990000000000000201/mapping`;
  const incomplete = draft();
  incomplete.decision = 'review_recorded';
  expect((await call('PUT', path, { revision: 0, mapping: incomplete })).statusCode).toBe(400);
  const wrong = draft();
  wrong.ingredients[0]!.sourceId = '999';
  expect((await call('PUT', path, { revision: 0, mapping: wrong })).statusCode).toBe(400);
  const valueWithoutUnit = draft();
  valueWithoutUnit.ingredients[0]!.value = 5;
  expect((await call('PUT', path, { revision: 0, mapping: valueWithoutUnit })).statusCode).toBe(
    400,
  );
  expect(await h.owner.medicineImportMapping.count()).toBe(0);
});

it('isolates the private import from clinic accounts and prevents platform source mutations', async () => {
  const { releaseId } = await importRelease();
  expect(
    (await h.app.inject({ method: 'GET', url: '/v1/platform/medicine-imports' })).statusCode,
  ).toBe(401);
  const clinics = await seedTwoClinics(h);
  const staff = await staffLogin(h, clinics.a.org.slug, clinics.a.admin);
  expect((await call('GET', 'medicine-imports', undefined, staff)).statusCode).toBe(401);
  await expect(
    withTenant(h.owner, clinics.a.org.id, (tx) => tx.medicineImportBrand.count()),
  ).rejects.toThrow(/permission denied/);
  await expect(
    withPlatform(h.owner, (tx) => tx.medicineImportRelease.deleteMany()),
  ).rejects.toThrow(/permission denied/);
  await expect(
    withPlatform(
      h.owner,
      (tx) =>
        tx.$executeRaw`UPDATE medicine_import_generics SET name='tamper' WHERE release_id=${releaseId}::uuid`,
    ),
  ).rejects.toThrow(/permission denied/);
});

it('rolls back the entire full-release import if a brand cannot link to its generic', async () => {
  const invalid = parsed();
  invalid.catalogue.records[0]!.generic.sourceId = '999';
  await expect(importMedicineRelease(h.owner, invalid, options())).rejects.toThrow();
  expect(await h.owner.medicineImportRelease.count()).toBe(0);
  expect(await h.owner.medicineImportSourceRow.count()).toBe(0);
  expect(await h.owner.medicineImportGeneric.count()).toBe(0);
  expect(
    await h.owner.auditLog.count({ where: { action: 'platform.medicine.import.completed' } }),
  ).toBe(0);
});

it('allows only one concurrent save at a revision', async () => {
  const { releaseId } = await importRelease();
  const path = `medicine-imports/${releaseId}/generics/990000000000000201/mapping`;
  const results = await Promise.all([
    call('PUT', path, { revision: 0, mapping: draft() }),
    call('PUT', path, { revision: 0, mapping: draft() }),
  ]);
  expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
  expect(await h.owner.medicineImportMapping.count()).toBe(1);
});

it('imports unreferenced generics and paginates source-code search without skipping records', async () => {
  const extended = { ...files };
  const seed = extended['GenericMaster.txt'].split('\n')[1]!.replace(/\r$/, '').split('\t');
  extended['GenericMaster.txt'] +=
    Array.from({ length: 40 }, (_, i) => {
      const row = [...seed];
      row[0] = String(990000000000001000n + BigInt(i));
      row[1] = `Synthetic standalone ${i}`;
      return row.join('\t');
    }).join('\n') + '\n';
  const full = stageImportCatalogue({ ...manifest, dataKind: 'real' }, extended, {
    includeSourceRows: true,
  });
  const { releaseId } = await importMedicineRelease(h.owner, full, options());
  expect(await h.owner.medicineImportGeneric.count()).toBe(42);
  // Draft rows sort first, so filtering after LIMIT would skip untouched records.
  for (let i = 0; i < 5; i++) {
    const code = String(990000000000001000n + BigInt(i));
    const saved = await call('PUT', `medicine-imports/${releaseId}/generics/${code}/mapping`, {
      revision: 0,
      mapping: draft(),
    });
    expect(saved.statusCode, saved.body).toBe(200);
  }
  const first = (
    await call('GET', `medicine-imports/${releaseId}/generics?status=untouched&q=standalone`)
  ).json();
  expect(first.data).toHaveLength(25);
  expect(first.nextCursor).not.toBeNull();
  const second = (
    await call(
      'GET',
      `medicine-imports/${releaseId}/generics?status=untouched&q=standalone&cursor=${first.nextCursor}`,
    )
  ).json();
  expect(second.data).toHaveLength(10);
  expect(second.nextCursor).toBeNull();
  expect(
    new Set([...first.data, ...second.data].map((g: { sourceId: string }) => g.sourceId)).size,
  ).toBe(35);
});
