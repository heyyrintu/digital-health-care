/** Entirely fabricated source, approvals and clinical facts. No real licence/sign-off. */
import { readFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { afterAll, beforeEach, expect, it } from 'vitest';
import { ClinicalMapping } from '@dhc/contracts';
import { withPlatform, withTenant } from '@dhc/db';
import { hashPassword } from '../src/auth/password';
import {
  FILES,
  stageImportCatalogue,
  type FileName,
} from '../src/modules/medicine-staging/catalogue';
import { importMedicineRelease } from '../src/modules/medicine-import/importer';
import {
  publishCatalogue,
  recordCatalogueEvidence,
  revokeCatalogueEvidence,
  withdrawCatalogue,
} from '../src/modules/medicine-import/publication';
import { assertCatalogueMedicines } from '../src/modules/medicines/catalogue-access';
import {
  createHarness,
  resetDatabase,
  addOperator,
  platformLogin,
  seedTwoClinics,
  staffLogin,
  bearer,
} from './harness';

const h = createHarness();
const fixture = new URL('./fixtures/cdci-synthetic/', import.meta.url);
const files = Object.fromEntries(
  Object.keys(FILES).map((f) => [f, readFileSync(new URL(f, fixture), 'utf8')]),
) as Record<FileName, string>;
const source = {
  format: 'cdci-flat-files/v1',
  dataKind: 'real',
  datasetKey: 'fabricated-publication-test',
  version: 'fixture-1',
};
const audit = {
  id: 'fabricated-publication-test',
  ip: '127.0.0.1',
  headers: { 'user-agent': 'synthetic-test-only' },
};
const validity = { validFrom: '2020-01-01T00:00:00.000Z', validUntil: '2040-01-01T00:00:00.000Z' };
let op: Awaited<ReturnType<typeof addOperator>>, tokens: Awaited<ReturnType<typeof platformLogin>>;
let clinics: Awaited<ReturnType<typeof seedTwoClinics>>,
  doctor: Awaited<ReturnType<typeof staffLogin>>;
let releaseId: string,
  moleculeId: string,
  profileId: string,
  licenceId: string,
  clinicalId: string,
  safetyId: string;
let mapping: ClinicalMapping,
  seq = 0;
const call = (method: 'GET' | 'PUT' | 'POST', path: string, payload?: object, auth = tokens) =>
  h.app.inject({
    method,
    url: '/v1/' + path,
    headers: bearer(auth),
    payload,
    remoteAddress: `127.0.0.${++seq}`,
  });
const evidence = (input: unknown) =>
  recordCatalogueEvidence(
    h.owner,
    h.services.files,
    op.operatorId,
    audit,
    input,
    Buffer.from('Fabricated test evidence only. Not a real licence or clinician approval.'),
  );
const request = (over: Record<string, unknown> = {}) => ({
  releaseId,
  sourceId: '990000000000000201',
  revision: 1,
  licenceId,
  clinicalId,
  safetyId,
  brandIds: ['990000000000000701'],
  expectedRevisions: { '990000000000000701': null },
  ...over,
});
const publish = (over: Record<string, unknown> = {}, execute = true) =>
  publishCatalogue(h.owner, h.services.files, op.operatorId, audit, request(over), execute);
const saveMapping = async (value: ClinicalMapping, revision = 1) => {
  const r = await call(
    'PUT',
    `platform/medicine-imports/${releaseId}/generics/990000000000000201/mapping`,
    { revision, mapping: value },
  );
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
};
const clinicalEvidence = (revision = 1) =>
  evidence({
    kind: 'clinical',
    brandIds: ['990000000000000701'],
    brandRegulatoryReviewConfirmed: true,
    releaseId,
    sourceId: '990000000000000201',
    revision,
    doctorProfileId: profileId,
    reviewEvidenceConfirmed: true,
    ...validity,
  });
async function medicine() {
  return h.owner.medicine.findFirstOrThrow({ where: { catalogueRevision: { not: null } } });
}
async function visit() {
  const clinic = await h.owner.clinic.create({
    data: {
      organisationId: clinics.a.org.id,
      name: 'Synthetic room',
      address: 'Synthetic address',
    },
  });
  const type = await h.owner.consultationType.create({
    data: {
      organisationId: clinics.a.org.id,
      name: 'Synthetic visit',
      mode: 'in_person',
      defaultDurationMin: 15,
      feePaise: 0,
    },
  });
  return h.owner.appointment.create({
    data: {
      organisationId: clinics.a.org.id,
      patientId: clinics.a.patients[0]!.id,
      doctorUserId: clinics.a.doctor.userId,
      clinicId: clinic.id,
      consultationTypeId: type.id,
      date: new Date('2026-10-06T00:00:00Z'),
      startAt: new Date('2026-10-06T04:30:00Z'),
      endAt: new Date('2026-10-06T04:45:00Z'),
      status: 'in_consultation',
      source: 'front_desk',
      tokenNumber: 1,
      createdByUserId: clinics.a.doctor.userId,
    },
  });
}
async function draft() {
  const m = await medicine(),
    v = await visit();
  const item = {
    id: randomUUID(),
    medicineId: m.id,
    catalogueRevision: m.catalogueRevision,
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
  };
  const r = await call(
    'PUT',
    `appointments/${v.id}/prescription`,
    { revision: 0, language: 'en', items: [item] },
    doctor,
  );
  expect(r.statusCode, r.body).toBe(200);
  return { visit: v, prescription: r.json(), item };
}
beforeEach(async () => {
  h.clock.ms = Date.UTC(2026, 9, 6, 4, 30);
  seq = 0;
  await resetDatabase(h.owner);
  op = await addOperator(h);
  tokens = await platformLogin(h, op);
  clinics = await seedTwoClinics(h);
  await h.owner.user.update({
    where: { id: clinics.a.doctor.userId },
    data: { displayName: 'Synthetic Reviewer' },
  });
  doctor = await staffLogin(h, 'clinic-a', clinics.a.doctor);
  await h.owner.patient.update({
    where: { id: clinics.a.patients[0]!.id },
    data: { dob: new Date('1985-01-01T00:00:00Z'), gender: 'female' },
  });
  const profile = await h.owner.doctorProfile.create({
    data: {
      organisationId: clinics.a.org.id,
      userId: clinics.a.doctor.userId,
      registrationNumber: 'FIXTURE-1',
      council: 'Synthetic council',
      qualifications: 'Synthetic qualification',
      rxPrefix: 'TEST',
      verification: 'verified',
      verifiedAt: h.clock.now(),
      verifiedBy: 'Synthetic operator',
      signingPinHash: await hashPassword(h.services.pepperPin(clinics.a.doctor.userId, '482916')),
    },
  });
  profileId = profile.id;
  moleculeId = (
    await h.owner.drugMolecule.create({ data: { name: 'Synthetic Alpha', maxDailyMg: 1000 } })
  ).id;
  await h.owner.drugDatabase.create({ data: { id: 1, version: 'fabricated-clinical-facts-v1' } });
  const imported = await importMedicineRelease(
    h.owner,
    stageImportCatalogue(source, files, { includeSourceRows: true }),
    {
      operatorId: op.operatorId,
      packageSha256: 'a'.repeat(64),
      licenceTextSha256: 'b'.repeat(64),
      audit,
    },
  );
  releaseId = imported.releaseId;
  mapping = ClinicalMapping.parse({
    form: 'tablet',
    route: 'oral',
    ingredients: [
      {
        sourceId: '990000000000000101',
        moleculeId,
        canonicalName: 'Synthetic Alpha',
        strengthStatus: 'mapped',
        value: 5,
        unit: 'mg',
        per: 'unit',
        reason: null,
      },
    ],
    regulatoryEvidence: 'Synthetic regulatory evidence only',
    notes: 'Synthetic clinician review fixture only',
    decision: 'review_recorded',
    reviewerName: 'Synthetic Reviewer',
    reviewerRegistration: 'FIXTURE-1',
    reviewAttested: true,
  });
  const saved = await call(
    'PUT',
    `platform/medicine-imports/${releaseId}/generics/990000000000000201/mapping`,
    { revision: 0, mapping },
  );
  expect(saved.statusCode, saved.body).toBe(200);
  licenceId = (
    await evidence({
      kind: 'licence',
      datasetKey: source.datasetKey,
      affiliateReference: 'SYNTHETIC-LICENCE',
      licenceTextSha256: 'b'.repeat(64),
      licensee: 'Synthetic test entity',
      territory: 'IN',
      useWithinIndiaConfirmed: true,
      ...validity,
    })
  ).id;
  safetyId = (
    await evidence({
      kind: 'safety',
      databaseVersion: 'fabricated-clinical-facts-v1',
      doctorProfileId: profileId,
      reviewEvidenceConfirmed: true,
      ...validity,
    })
  ).id;
  clinicalId = (await clinicalEvidence()).id;
});
afterAll(async () => {
  await h.app.close();
  await h.owner.$disconnect();
});

it('previews without activation, publishes canonical ingredients and stable source provenance, and replays unchanged', async () => {
  expect(await publish({}, false)).toMatchObject({ executed: false, changed: 1, selected: 1 });
  expect(await h.owner.medicine.count()).toBe(0);
  expect(await publish()).toMatchObject({ executed: true, changed: 1 });
  expect(await publish()).toMatchObject({ changed: 0 }); // Lost-response replay of the original create request.
  const m = await medicine();
  expect(m.catalogueRevision).toBe(1);
  const i = await h.owner.medicineIngredient.findFirstOrThrow({ where: { medicineId: m.id } });
  expect(i.moleculeId).toBe(moleculeId);
  expect(i.strengthMg!.toString()).toBe('5');
  expect(await publish({ expectedRevisions: { '990000000000000701': 1 } })).toMatchObject({
    changed: 0,
  });
  expect(await h.owner.medicineCataloguePublicationEvent.count()).toBe(1);
  const search = await call('GET', 'medicines?q=Synthetic', undefined, doctor);
  expect(search.statusCode, search.body).toBe(200);
  expect(search.json().data[0]).toMatchObject({ id: m.id, catalogueRevision: 1 });
});

it('requires all three valid evidence records and refuses missing or changed documents', async () => {
  await expect(publish({ licenceId: randomUUID() })).rejects.toThrow('all required');
  const record = await h.owner.medicineCatalogueEvidence.findUniqueOrThrow({
    where: { id: licenceId },
  });
  await h.services.files.delete(record.fileKey);
  await expect(publish()).rejects.toThrow();
  expect(await h.owner.medicine.count()).toBe(0);
});

it('keeps medicine IDs stable across reviewed mapping updates and refuses stale published revisions', async () => {
  await publish();
  const before = await medicine();
  const oldDraft = await draft();
  const next = ClinicalMapping.parse({ ...mapping, form: 'synthetic tablet' });
  await saveMapping(next);
  clinicalId = (await clinicalEvidence(2)).id;
  await publish({ revision: 2, expectedRevisions: { '990000000000000701': 1 } });
  expect((await medicine()).id).toBe(before.id);
  expect((await medicine()).catalogueRevision).toBe(2);
  const sign = await call(
    'POST',
    `appointments/${oldDraft.visit.id}/prescription/sign`,
    { revision: oldDraft.prescription.revision, pin: '482916' },
    doctor,
  );
  expect(sign.statusCode, sign.body).toBe(400);
  expect(sign.json().error.message).toContain('Select it again');
  await expect(
    publish({ revision: 2, expectedRevisions: { '990000000000000701': 99 } }),
  ).rejects.toThrow('changed');
});

it('removes revoked approval from picking and signing while preserving signed PDFs and editable historical amendments', async () => {
  await publish();
  const original = await draft();
  const signed = await call(
    'POST',
    `appointments/${original.visit.id}/prescription/sign`,
    { revision: original.prescription.revision, pin: '482916' },
    doctor,
  );
  expect(signed.statusCode, signed.body).toBe(200);
  const row = await h.owner.prescription.findUniqueOrThrow({ where: { id: signed.json().id } });
  const bytes = await h.services.files.get(row.pdfFileKey!);
  await revokeCatalogueEvidence(
    h.owner,
    op.operatorId,
    audit,
    licenceId,
    'Synthetic licence revocation fixture',
  );
  const search = await call('GET', 'medicines?q=Synthetic', undefined, doctor);
  expect(search.json().data).toHaveLength(0);
  expect(
    createHash('sha256')
      .update(await h.services.files.get(row.pdfFileKey!))
      .digest('hex'),
  ).toBe(createHash('sha256').update(bytes).digest('hex'));
  const amend = await call(
    'POST',
    `appointments/${original.visit.id}/prescription/amend`,
    { reason: 'Synthetic correction after withdrawal' },
    doctor,
  );
  expect(amend.statusCode, amend.body).toBe(201);
  const cannotSign = await call(
    'POST',
    `appointments/${original.visit.id}/prescription/sign`,
    { revision: amend.json().revision, pin: '482916' },
    doctor,
  );
  expect(cannotSign.statusCode, cannotSign.body).toBe(400);
});

it('automatically revokes safety evidence if reference facts change, even under the same version', async () => {
  await publish();
  await h.owner.drugMolecule.update({ where: { id: moleculeId }, data: { hepaticCaution: true } });
  expect(
    (await h.owner.medicineCatalogueEvidence.findUniqueOrThrow({ where: { id: safetyId } }))
      .revokedAt,
  ).not.toBeNull();
  const m = await medicine();
  await expect(
    withTenant(h.owner, clinics.a.org.id, (tx) =>
      assertCatalogueMedicines(tx, [{ medicineId: m.id, catalogueRevision: 1 }]),
    ),
  ).rejects.toThrow('approval is unavailable');
});

it('requires explicit legacy cutover and hides unreviewed reference choices only after approved activation', async () => {
  const legacy = await h.owner.medicine.create({
    data: {
      source: 'reference',
      name: 'Synthetic legacy',
      genericName: 'Synthetic legacy',
      composition: 'Synthetic legacy',
      form: 'tablet',
    },
  });
  expect(await publish({}, false)).toMatchObject({ legacyReferencesRetiredFromPicking: 1 });
  await expect(publish()).rejects.toThrow('Confirm the cutover');
  expect(await h.owner.medicineCataloguePublication.count()).toBe(0);
  await publish({ confirmLegacyRetirement: true });
  const search = await call('GET', 'medicines?q=Synthetic', undefined, doctor);
  expect(search.json().data.some((m: { id: string }) => m.id === legacy.id)).toBe(false);
  expect((await h.owner.medicine.findUniqueOrThrow({ where: { id: legacy.id } })).name).toBe(
    'Synthetic legacy',
  );
});

it('rejects lossy or unsupported strengths without rounding or manufacturing safety data', async () => {
  const next = ClinicalMapping.parse({
    ...mapping,
    ingredients: [{ ...mapping.ingredients[0]!, value: 0.1, unit: 'microgram' }],
  });
  await saveMapping(next);
  clinicalId = (await clinicalEvidence(2)).id;
  await expect(publish({ revision: 2 })).rejects.toThrow('must not be rounded');
  expect(await h.owner.medicine.count()).toBe(0);
});

it('withdraws source brands without deleting history and requires fresh post-withdrawal clinical evidence to reactivate', async () => {
  await publish();
  const m = await medicine();
  const saved = await draft();
  const withdrawal = {
    datasetKey: source.datasetKey,
    expectedRevisions: { '990000000000000701': 1 },
    reason: 'Synthetic withdrawal fixture only',
  };
  await withdrawCatalogue(h.owner, op.operatorId, audit, withdrawal, true);
  expect(await withdrawCatalogue(h.owner, op.operatorId, audit, withdrawal, true)).toMatchObject({
    unchanged: true,
  });
  expect((await medicine()).active).toBe(false);
  await expect(
    h.owner.prescriptionItem.update({
      where: { id: saved.item.id },
      data: { catalogueRevision: 2 },
    }),
  ).rejects.toThrow('Medicine catalogue changed');
  await expect(
    withdrawCatalogue(
      h.owner,
      op.operatorId,
      audit,
      {
        ...withdrawal,
        expectedRevisions: { '990000000000000701': 2 },
        reason: 'Different synthetic withdrawal request',
      },
      true,
    ),
  ).rejects.toThrow('already withdrawn');
  await expect(
    publish({ reactivate: true, expectedRevisions: { '990000000000000701': 2 } }),
  ).rejects.toThrow('fresh clinician evidence');
  clinicalId = (await clinicalEvidence()).id;
  await publish({ reactivate: true, expectedRevisions: { '990000000000000701': 2 } });
  expect((await medicine()).id).toBe(m.id);
  expect((await medicine()).catalogueRevision).toBe(3);
  expect(await h.owner.medicineCataloguePublicationEvent.count()).toBe(3);
});

it('keeps approval and publication mutations out of the platform SQL role', async () => {
  await expect(
    withPlatform(h.owner, (tx) => tx.medicineCatalogueEvidence.deleteMany()),
  ).rejects.toThrow(/permission denied/);
  await expect(
    withPlatform(h.owner, (tx) => tx.medicineCataloguePublication.deleteMany()),
  ).rejects.toThrow(/permission denied/);
  await expect(
    h.owner.medicineCatalogueEvidence.update({
      where: { id: licenceId },
      data: { scopeKey: 'tampered' },
    }),
  ).rejects.toThrow('Evidence is immutable');
  await h.owner.doctorProfile.update({
    where: { id: profileId },
    data: { verification: 'pending', verifiedAt: null, verifiedBy: null },
  });
  await expect(clinicalEvidence()).rejects.toThrow('verified');
});

it('requires brand-specific review instead of widening a generic approval to another source brand', async () => {
  const original = await h.owner.medicineImportBrand.findUniqueOrThrow({
    where: { releaseId_sourceId: { releaseId, sourceId: '990000000000000701' } },
  });
  const extraId = '990000000000000704';
  await h.owner.medicineImportBrand.create({
    data: {
      releaseId,
      sourceId: extraId,
      genericId: original.genericId,
      name: 'Synthetic unreviewed extra brand',
      source: {
        ...(original.source as object),
        sourceId: extraId,
        name: 'Synthetic unreviewed extra brand',
      },
    },
  });
  await expect(
    publish({ brandIds: [extraId], expectedRevisions: { [extraId]: null } }),
  ).rejects.toThrow('each selected brand');
  expect(await h.owner.medicine.count()).toBe(0);
});

it('refuses expired licence evidence even when the document and reviewer records exist', async () => {
  const expired = await evidence({
    kind: 'licence',
    datasetKey: source.datasetKey,
    affiliateReference: 'EXPIRED-SYNTHETIC',
    licenceTextSha256: 'b'.repeat(64),
    licensee: 'Synthetic test entity',
    territory: 'IN',
    useWithinIndiaConfirmed: true,
    validFrom: '2000-01-01T00:00:00.000Z',
    validUntil: '2001-01-01T00:00:00.000Z',
  });
  await expect(publish({ licenceId: expired.id })).rejects.toThrow(
    'expired, revoked or not effective',
  );
  expect(await h.owner.medicineCataloguePublication.count()).toBe(0);
});

it('refuses an old client without catalogue revisions and protects the selected product identity', async () => {
  await publish();
  const saved = await draft();
  const { catalogueRevision: _revision, ...oldClientItem } = saved.item;
  const missing = await call(
    'PUT',
    `appointments/${saved.visit.id}/prescription`,
    { revision: saved.prescription.revision, language: 'en', items: [oldClientItem] },
    doctor,
  );
  expect(missing.statusCode, missing.body).toBe(400);
  const changed = await call(
    'PUT',
    `appointments/${saved.visit.id}/prescription`,
    {
      revision: saved.prescription.revision,
      language: 'en',
      items: [{ ...saved.item, name: 'Another product' }],
    },
    doctor,
  );
  expect(changed.statusCode, changed.body).toBe(400);
  await expect(
    h.owner.prescriptionItem.update({
      where: { id: saved.item.id },
      data: { catalogueRevision: null },
    }),
  ).rejects.toThrow('Medicine catalogue changed');
});

it('preserves source medicine IDs across release updates but requires review evidence for the new release', async () => {
  await publish();
  const first = await medicine(),
    firstRelease = releaseId;
  const imported = await importMedicineRelease(
    h.owner,
    stageImportCatalogue({ ...source, version: 'fixture-2' }, files, { includeSourceRows: true }),
    {
      operatorId: op.operatorId,
      packageSha256: 'c'.repeat(64),
      licenceTextSha256: 'b'.repeat(64),
      audit,
    },
  );
  releaseId = imported.releaseId;
  await saveMapping(mapping, 0);
  await expect(publish({ expectedRevisions: { '990000000000000701': 1 } })).rejects.toThrow(
    'exact current mapping',
  );
  clinicalId = (await clinicalEvidence()).id;
  await publish({ expectedRevisions: { '990000000000000701': 1 } });
  const updated = await medicine();
  expect(updated.id).toBe(first.id);
  expect(updated.catalogueRevision).toBe(2);
  const events = await h.owner.medicineCataloguePublicationEvent.findMany({
    where: { medicineId: first.id },
    orderBy: { revision: 'asc' },
  });
  expect((events[0]!.snapshot as { releaseId: string }).releaseId).toBe(firstRelease);
  expect((events[1]!.snapshot as { releaseId: string }).releaseId).toBe(releaseId);
});

it('rejects direct changes to a published name or recipe without a matching reviewed event', async () => {
  await publish();
  const m = await medicine();
  await expect(
    h.owner.medicine.update({ where: { id: m.id }, data: { name: 'Unreviewed replacement name' } }),
  ).rejects.toThrow('reviewed snapshot');
  await expect(
    h.owner.medicineIngredient.update({
      where: { medicineId_moleculeId: { medicineId: m.id, moleculeId } },
      data: { strengthMg: 50 },
    }),
  ).rejects.toThrow('reviewed snapshot');
  expect((await medicine()).name).toBe(m.name);
  expect(
    (
      await h.owner.medicineIngredient.findFirstOrThrow({ where: { medicineId: m.id } })
    ).strengthMg!.toString(),
  ).toBe('5');
});

it('includes published catalogue revisions in the offline medicine cache', async () => {
  await publish();
  const m = await medicine();
  await h.owner.medicine.update({
    where: { id: m.id },
    data: { updatedAt: new Date('2020-01-01') },
  });
  const response = await call('GET', 'sync/medicines', undefined, doctor);
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json().data).toContainEqual(
    expect.objectContaining({ id: m.id, catalogueRevision: 1 }),
  );
});

it('invalidates catalogue eligibility when the reviewing user is disabled', async () => {
  await publish();
  const m = await medicine();
  await h.owner.user.update({
    where: { id: clinics.a.doctor.userId },
    data: { status: 'disabled' },
  });
  const result = await withTenant(
    h.owner,
    clinics.b.org.id,
    (tx) =>
      tx.$queryRaw<
        { eligible: boolean }[]
      >`SELECT catalogue_medicine_eligible(${m.id}::uuid) eligible`,
  );
  expect(result[0]?.eligible).toBe(false);
});

it('holds clinic medicine activity stable until the prescribing transaction ends', async () => {
  const m = await h.owner.medicine.create({
    data: {
      organisationId: clinics.a.org.id,
      source: 'clinic',
      name: 'Synthetic custom',
      genericName: 'Synthetic custom',
      composition: 'Synthetic',
      form: 'tablet',
    },
  });
  await withTenant(h.owner, clinics.a.org.id, async (tx) => {
    await assertCatalogueMedicines(tx, [{ medicineId: m.id }]);
    await expect(
      h.owner.$transaction(async (other) => {
        await other.$executeRawUnsafe("SET LOCAL lock_timeout='150ms'");
        await other.medicine.update({ where: { id: m.id }, data: { active: false } });
      }),
    ).rejects.toThrow(/lock timeout/);
  });
  await h.owner.medicine.update({ where: { id: m.id }, data: { active: false } });
  await expect(
    withTenant(h.owner, clinics.a.org.id, (tx) =>
      assertCatalogueMedicines(tx, [{ medicineId: m.id }]),
    ),
  ).rejects.toThrow('not in the list');
});

it('rejects a source publication identity attached to another dataset', async () => {
  await publish();
  const m = await medicine();
  await expect(
    h.owner.medicineCataloguePublication.update({
      where: { medicineId: m.id },
      data: { datasetKey: 'another-dataset' },
    }),
  ).rejects.toThrow(/Foreign key/);
});
