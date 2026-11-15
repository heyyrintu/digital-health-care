import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { afterAll, beforeEach, expect, it } from 'vitest';
import { withPlatform, withTenant, withAuth } from '@dhc/db';
import { MedicineReviewBundle } from '@dhc/contracts';
import { FILES, stageCatalogue, type FileName } from '../src/modules/medicine-staging/catalogue';
import { IpAllowlist } from '../src/plugins/ip-allowlist';
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
let tokens: Awaited<ReturnType<typeof platformLogin>>;
let op: Awaited<ReturnType<typeof addOperator>>;
const fixture = new URL('./fixtures/cdci-synthetic/', import.meta.url);
const files = Object.fromEntries(
  Object.keys(FILES).map((f) => [f, readFileSync(new URL(f, fixture), 'utf8')]),
) as Record<FileName, string>;
const manifest = JSON.parse(readFileSync(new URL('manifest.json', fixture), 'utf8'));
const bundle = (version = 'fixture-1') =>
  MedicineReviewBundle.parse(stageCatalogue({ ...manifest, version }, files));
let requestNumber = 0;
const call = (method: 'GET' | 'POST', path: string, payload?: object, auth = tokens) =>
  h.app.inject({
    method,
    url: '/v1/platform/' + path,
    headers: auth ? bearer(auth) : {},
    remoteAddress: `127.0.0.${++requestNumber}`,
    payload,
  });
const upload = async (version = 'fixture-1') => {
  const r = await call('POST', 'medicine-stages', bundle(version));
  expect(r.statusCode, r.body).toBe(201);
  return r.json();
};
const review = (id: string, revision = 1, decision = 'reviewed') =>
  call('POST', `medicine-stages/${id}/review`, {
    revision,
    decision,
    note: 'Checked synthetic candidates and quarantine report.',
    scopeAcknowledged: true,
  });
const publish = (id: string, revision: number, expectedActiveStageId: string | null = null) =>
  call('POST', `medicine-stages/${id}/publish-sandbox`, { revision, expectedActiveStageId });
beforeEach(async () => {
  await resetDatabase(h.owner);
  op = await addOperator(h);
  tokens = await platformLogin(h, op);
});
afterAll(async () => {
  await h.app.close();
  await h.owner.$disconnect();
});

it('uploads idempotently, audits decisions, and keeps sandbox publication out of the clinical master', async () => {
  const before = await h.owner.medicine.count();
  const stage = await upload();
  expect(stage).toMatchObject({ state: 'pending', revision: 1, candidateCount: 2, issueCount: 1 });
  const duplicate = await call('POST', 'medicine-stages', bundle());
  expect(duplicate.statusCode).toBe(200);
  expect(duplicate.json().id).toBe(stage.id);
  expect(
    await h.owner.auditLog.count({ where: { action: 'platform.medicine.upload.replayed' } }),
  ).toBe(1);
  expect((await publish(stage.id, 1)).statusCode).toBe(409);
  expect((await review(stage.id)).statusCode).toBe(200);
  expect((await review(stage.id)).statusCode).toBe(409);
  const result = await publish(stage.id, 2);
  expect(result.statusCode, result.body).toBe(200);
  expect(result.json()).toMatchObject({
    stage: { state: 'published_demo', revision: 3 },
    clinicalPublicationAllowed: false,
  });
  expect((await call('GET', 'medicine-sandbox')).json().stage.id).toBe(stage.id);
  expect(await h.owner.medicine.count()).toBe(before);
  expect(await h.owner.prescription.count()).toBe(0);
  const audits = await h.owner.auditLog.findMany({
    where: { action: { startsWith: 'platform.medicine.' } },
  });
  expect(audits.map((a) => a.action)).toContain('platform.medicine.sandbox.published');
  expect(JSON.stringify(audits.map((a) => a.metadata))).not.toContain('Checked synthetic');
});

it('rejects real manifests, altered metadata, duplicate candidates, false safety claims and incomplete review', async () => {
  for (const change of [
    (b: ReturnType<typeof bundle>) => {
      (b.catalogue.source as { dataKind: string }).dataKind = 'real';
    },
    (b: ReturnType<typeof bundle>) => {
      b.provenance.fingerprint = '0'.repeat(64);
    },
    (b: ReturnType<typeof bundle>) => {
      b.report.rejectedBrands = 0;
    },
    (b: ReturnType<typeof bundle>) => {
      b.catalogue.records[1] = b.catalogue.records[0]!;
    },
    (b: ReturnType<typeof bundle>) => {
      (b.catalogue.records[0] as { clinicalSafety: string }).clinicalSafety = 'safe';
    },
  ]) {
    const input = bundle();
    change(input);
    expect((await call('POST', 'medicine-stages', input)).statusCode).toBe(400);
  }
  const s = await upload();
  expect(
    (
      await call('POST', `medicine-stages/${s.id}/review`, {
        revision: 1,
        decision: 'reviewed',
        note: 'too short',
        scopeAcknowledged: false,
      })
    ).statusCode,
  ).toBe(400);
  const changed = bundle();
  changed.catalogue.records[0]!.name += ' changed';
  // Different payload under an existing release name cannot silently replace it.
  expect((await call('POST', 'medicine-stages', changed)).statusCode).toBe(409);
});

it('serializes competing reviews and requires the current active sandbox before switching or rolling back', async () => {
  const a = await upload();
  const b = await upload('fixture-2');
  const decisions = await Promise.all([review(a.id), review(a.id, 1, 'rejected')]);
  expect(decisions.map((r) => r.statusCode).sort()).toEqual([200, 409]);
  // Whichever decision won is immutable; use a third snapshot for deterministic publication.
  const c = await upload('fixture-3');
  await review(c.id);
  await review(b.id);
  expect((await publish(c.id, 2)).statusCode).toBe(200);
  expect((await publish(b.id, 2)).statusCode).toBe(409);
  expect((await publish(b.id, 2, c.id)).statusCode).toBe(200);
  expect((await publish(c.id, 3, b.id)).statusCode).toBe(200);
  expect((await call('GET', 'medicine-stages?state=published_demo')).json().data).toHaveLength(2);
});

it('denies unauthenticated, clinic and disallowed-network access and enforces database isolation', async () => {
  const unauth = await h.app.inject({ method: 'GET', url: '/v1/platform/medicine-stages' });
  expect(unauth.statusCode).toBe(401);
  const clinics = await seedTwoClinics(h);
  const staff = await staffLogin(h, clinics.a.org.slug, clinics.a.admin);
  expect((await call('GET', 'medicine-stages', undefined, staff)).statusCode).toBe(401);
  const restricted = createHarness({ platformAllowlist: IpAllowlist.none() });
  const denied = await restricted.app.inject({
    method: 'GET',
    url: '/v1/platform/medicine-stages',
    headers: bearer(tokens),
    remoteAddress: '203.0.113.8',
  });
  expect(denied.statusCode).toBe(403);
  await restricted.app.close();
  await restricted.owner.$disconnect();
  const stage = await upload();
  await expect(
    withPlatform(h.services.db, (tx) =>
      tx.platformMedicineSandbox.create({
        data: { id: 1, stageId: stage.id, updatedBy: op.operatorId, updatedAt: h.clock.now() },
      }),
    ),
  ).rejects.toThrow('Only published synthetic snapshots');
  await expect(
    withAuth(h.services.db, (tx) => tx.platformMedicineStage.findMany()),
  ).rejects.toThrow();
  await expect(
    withTenant(h.services.db, clinics.a.org.id, (tx) => tx.platformMedicineStage.findMany()),
  ).rejects.toThrow();
  await expect(
    withPlatform(
      h.services.db,
      (tx) =>
        tx.$executeRaw`UPDATE platform_medicine_stages SET bundle='{}'::jsonb WHERE id=${stage.id}::uuid`,
    ),
  ).rejects.toThrow();
  await expect(
    withPlatform(h.services.db, (tx) => tx.$executeRaw`DELETE FROM medicines`),
  ).rejects.toThrow();
});

it('paginates immutable snapshots without skipping ties and makes a rejected snapshot unpublishable', async () => {
  for (let i = 0; i < 22; i++) await upload(`page-${i}`);
  const first = (await call('GET', 'medicine-stages')).json();
  expect(first.data).toHaveLength(20);
  expect(first.nextCursor).toBeTruthy();
  const second = (await call('GET', `medicine-stages?cursor=${first.nextCursor}`)).json();
  expect(second.data).toHaveLength(2);
  expect(second.nextCursor).toBeNull();
  expect(
    (await call('GET', `medicine-stages?state=rejected&cursor=${first.nextCursor}`)).statusCode,
  ).toBe(400);
  expect(new Set([...first.data, ...second.data].map((r) => r.id)).size).toBe(22);
  const id = first.data[0].id;
  expect((await review(id, 1, 'rejected')).statusCode).toBe(200);
  expect((await publish(id, 2)).statusCode).toBe(409);
  expect((await call('GET', 'medicine-stages?state=rejected')).json().data).toHaveLength(1);
});

it('exports an audited, private, synthetic worksheet without changing the snapshot or clinical data', async () => {
  const stage = await upload();
  const medicines = await h.owner.medicine.count();
  const response = await call('GET', `medicine-stages/${stage.id}/worksheet`);
  expect(response.statusCode, response.body).toBe(200);
  expect(response.headers['content-type']).toContain('text/csv');
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.headers['content-disposition']).toBe(
    `attachment; filename="medicine-review-${stage.id}.csv"`,
  );
  expect(response.body).toContain('synthetic_sandbox_only');
  expect(response.body).toContain("'990000000000000701");
  expect(response.body).not.toContain('990000000000000703');
  expect(await h.owner.medicine.count()).toBe(medicines);
  expect(await h.owner.prescription.count()).toBe(0);
  expect(
    (await h.owner.platformMedicineStage.findUniqueOrThrow({ where: { id: stage.id } })).revision,
  ).toBe(1);
  const audit = await h.owner.auditLog.findFirstOrThrow({
    where: { action: 'platform.medicine.worksheet.exported' },
  });
  expect(audit.metadata).toEqual({ stageId: stage.id });
  const unauth = await h.app.inject({
    method: 'GET',
    url: `/v1/platform/medicine-stages/${stage.id}/worksheet`,
  });
  expect(unauth.statusCode).toBe(401);
  const clinics = await seedTwoClinics(h);
  const staff = await staffLogin(h, clinics.a.org.slug, clinics.a.admin);
  expect(
    (await call('GET', `medicine-stages/${stage.id}/worksheet`, undefined, staff)).statusCode,
  ).toBe(401);
  expect((await call('GET', 'medicine-stages/invalid/worksheet')).statusCode).toBe(400);
  expect(
    (await call('GET', 'medicine-stages/00000000-0000-4000-8000-000000000001/worksheet'))
      .statusCode,
  ).toBe(404);
});

it('indexes all seven source kinds and exact brand links without importing quarantined or clinical records', async () => {
  const medicines = await h.owner.medicine.count();
  const stage = await upload();
  const identities = await h.owner.platformMedicineIdentity.findMany();
  expect(identities).toHaveLength(12);
  expect(new Set(identities.map((i) => i.kind))).toEqual(
    new Set(['brand', 'product', 'supplier', 'generic', 'ingredient', 'form', 'route']),
  );
  expect(identities.every((i) => /^\d{18}$/.test(i.sourceId))).toBe(true);
  expect(identities.some((i) => i.sourceId === '990000000000000703')).toBe(false);
  expect(await h.owner.platformMedicineEntity.count()).toBe(12);
  expect(await h.owner.platformMedicineLink.count()).toBe(14);
  const brand = identities.find((i) => i.kind === 'brand' && i.sourceId.endsWith('702'))!;
  const links = await h.owner.platformMedicineLink.findMany({
    where: { stageId: stage.id, fromId: brand.id },
    include: { to: { include: { identity: true } } },
  });
  expect(links).toHaveLength(8);
  expect(
    links
      .filter((l) => l.to.identity.kind === 'ingredient')
      .map((l) => l.to.name)
      .sort(),
  ).toEqual(['Synthetic substance Alpha', 'Synthetic substance Beta']);
  expect(await h.owner.medicine.count()).toBe(medicines);
  expect(await h.owner.prescription.count()).toBe(0);
});

it('retains stable identities across release renames, isolates datasets and leaves old release names intact', async () => {
  const first = await upload();
  const identity = await h.owner.platformMedicineIdentity.findFirstOrThrow({
    where: { kind: 'brand', sourceId: '990000000000000701' },
  });
  const next = bundle('fixture-2');
  next.catalogue.records[0]!.name = 'Synthetic renamed brand';
  const response = await call('POST', 'medicine-stages', next);
  expect(response.statusCode, response.body).toBe(201);
  const second = response.json();
  const entities = await h.owner.platformMedicineEntity.findMany({
    where: { identityId: identity.id },
  });
  expect(entities).toHaveLength(2);
  expect(entities.find((e) => e.stageId === first.id)?.name).toBe('Synthetic brand One');
  expect(entities.find((e) => e.stageId === second.id)?.name).toBe('Synthetic renamed brand');
  expect(await h.owner.platformMedicineIdentity.count()).toBe(12);
  expect((await call('POST', 'medicine-stages', next)).statusCode).toBe(200);
  expect(await h.owner.platformMedicineEntity.count()).toBe(24);
  const separate = stageCatalogue({ ...manifest, datasetKey: 'another-synthetic-source' }, files);
  expect((await call('POST', 'medicine-stages', separate)).statusCode).toBe(201);
  expect(await h.owner.platformMedicineIdentity.count()).toBe(24);
  expect(
    await h.owner.platformMedicineIdentity.count({
      where: { kind: 'brand', sourceId: identity.sourceId },
    }),
  ).toBe(2);
  expect(
    (await h.owner.platformMedicineStage.findUniqueOrThrow({ where: { id: first.id } })).revision,
  ).toBe(1);
});

it('allows platform read access only and rejects direct index writes and private helper execution', async () => {
  const stage = await upload();
  expect(await withPlatform(h.owner, (tx) => tx.platformMedicineEntity.count())).toBe(12);
  for (const table of [
    'platform_medicine_identities',
    'platform_medicine_entities',
    'platform_medicine_links',
  ]) {
    await expect(
      withPlatform(h.owner, (tx) => tx.$executeRawUnsafe(`DELETE FROM ${table}`)),
    ).rejects.toThrow(/permission denied/);
  }
  await expect(
    withPlatform(
      h.owner,
      (tx) => tx.$executeRaw`SELECT index_platform_medicine_stage(${stage.id}::uuid)`,
    ),
  ).rejects.toThrow(/permission denied/);
  const clinics = await seedTwoClinics(h);
  await expect(
    withTenant(h.owner, clinics.a.org.id, (tx) => tx.platformMedicineIdentity.count()),
  ).rejects.toThrow(/permission denied/);
  await expect(withAuth(h.owner, (tx) => tx.platformMedicineEntity.count())).rejects.toThrow(
    /permission denied/,
  );
});

it('rolls back the complete snapshot and index on invalid source identifiers', async () => {
  const malformed = bundle();
  malformed.catalogue.records[0]!.ingredients[0]!.sourceId = 'not-an-id';
  await expect(
    h.owner.platformMedicineStage.create({
      data: {
        datasetKey: manifest.datasetKey,
        sourceVersion: manifest.version,
        fingerprint: malformed.catalogue.fingerprint,
        bundleHash: 'a'.repeat(64),
        bundle: malformed,
        candidateCount: 2,
        issueCount: 1,
        createdBy: op.operatorId,
      },
    }),
  ).rejects.toThrow(/check constraint/);
  expect(await h.owner.platformMedicineStage.count()).toBe(0);
  expect(await h.owner.platformMedicineIdentity.count()).toBe(0);
  expect(await h.owner.platformMedicineEntity.count()).toBe(0);
  expect(await h.owner.platformMedicineLink.count()).toBe(0);
});

it('backfills existing reviewed releases without changing their bytes, decisions or active selection', async () => {
  const stage = await upload();
  await review(stage.id);
  await publish(stage.id, 2);
  const other = await upload('fixture-second');
  await review(other.id);
  await publish(other.id, 2, stage.id);
  const original = await h.owner.platformMedicineStage.findUniqueOrThrow({
    where: { id: stage.id },
  });
  const client = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await client.connect();
  try {
    await client.query('BEGIN');
    // Recreate only this migration within a transaction, simulating a database
    // that already contains pre-index snapshots. Roll back all DDL afterward.
    await client.query(`DROP TRIGGER platform_medicine_stage_index ON platform_medicine_stages;
      DROP FUNCTION index_new_platform_medicine_stage();
      DROP FUNCTION index_platform_medicine_stage(uuid);
      DROP TABLE platform_medicine_links,platform_medicine_entities,platform_medicine_identities;`);
    await client.query(
      readFileSync(
        new URL(
          '../../../packages/db/prisma/migrations/20261113090000_medicine_catalogue_index/migration.sql',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    expect(
      (await client.query('SELECT count(*)::int AS n FROM platform_medicine_entities')).rows[0].n,
    ).toBe(24);
    expect(
      (await client.query('SELECT count(*)::int AS n FROM platform_medicine_links')).rows[0].n,
    ).toBe(28);
    const restored = (
      await client.query(
        'SELECT bundle,revision,state,review_note FROM platform_medicine_stages WHERE id=$1',
        [stage.id],
      )
    ).rows[0];
    expect(restored).toEqual({
      bundle: original.bundle,
      revision: original.revision,
      state: original.state,
      review_note: original.reviewNote,
    });
    expect(
      (await client.query('SELECT stage_id FROM platform_medicine_sandbox')).rows[0].stage_id,
    ).toBe(other.id);
  } finally {
    await client.query('ROLLBACK');
    await client.end();
  }
});

it('indexes the maximum accepted snapshot with shared references without duplicating those identities', async () => {
  const input = bundle();
  const template = input.catalogue.records[0]!;
  input.catalogue.records = Array.from({ length: 500 }, (_, i) => ({
    ...template,
    sourceId: String(990000000000001000n + BigInt(i)),
    name: `Synthetic test brand ${i}`,
  }));
  input.report.candidateBrands = 500;
  input.report.tables['BrandMaster.txt'].inputRows = 501;
  input.report.tables['BrandMaster.txt'].indexedRows = 500;
  const response = await call('POST', 'medicine-stages', input);
  expect(response.statusCode, response.body).toBe(201);
  expect(await h.owner.platformMedicineIdentity.count()).toBe(506);
  expect(await h.owner.platformMedicineEntity.count()).toBe(506);
  expect(await h.owner.platformMedicineLink.count()).toBe(3000);
});

it('indexes concurrent releases consistently and distinguishes the same code in different entity kinds', async () => {
  const first = bundle('parallel-1');
  const second = bundle('parallel-2');
  for (const input of [first, second]) {
    input.catalogue.records[0]!.product.sourceId = input.catalogue.records[0]!.sourceId;
  }
  const results = await Promise.all([
    call('POST', 'medicine-stages', first),
    call('POST', 'medicine-stages', second),
  ]);
  for (const response of results) expect(response.statusCode, response.body).toBe(201);
  expect(await h.owner.platformMedicineIdentity.count()).toBe(12);
  expect(await h.owner.platformMedicineEntity.count()).toBe(24);
  expect(await h.owner.platformMedicineLink.count()).toBe(28);
  const reusedCode = await h.owner.platformMedicineIdentity.findMany({
    where: { sourceId: first.catalogue.records[0]!.sourceId },
  });
  expect(reusedCode.map((i) => i.kind).sort()).toEqual(['brand', 'product']);
  expect(new Set(reusedCode.map((i) => i.id)).size).toBe(2);
});
