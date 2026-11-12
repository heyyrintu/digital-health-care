import { readFileSync } from 'node:fs';
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
