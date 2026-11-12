import { randomUUID } from 'node:crypto';
import {
  MedicineReviewBundle,
  MedicineStageDetail,
  MedicineStageSummary,
  type MedicineStageReviewBody,
  type MedicineStagePublishBody,
} from '@dhc/contracts';
import { withPlatform, type Prisma, type Tx } from '@dhc/db';
import type { FastifyRequest } from 'fastify';
import type { Services } from '../../services';
import { AppError } from '../../errors';
import { FILES, digest } from '../medicine-staging/catalogue';
import { writeAudit } from '../audit/write';

const conflict = () =>
  new AppError(
    409,
    'CONFLICT',
    'This snapshot or the active sandbox changed. Reload before continuing.',
  );
const invalid = (message: string) => new AppError(400, 'VALIDATION_FAILED', message);
const include = { reviewer: { select: { displayName: true } } } as const;
type Row = Prisma.PlatformMedicineStageGetPayload<{ include: typeof include }>;
const summary = (r: Row) =>
  MedicineStageSummary.parse({
    ...r,
    createdAt: r.createdAt.toISOString(),
    reviewedAt: r.reviewedAt?.toISOString() ?? null,
    reviewerName: r.reviewer?.displayName ?? null,
  });
const detail = (r: Row) => MedicineStageDetail.parse({ ...summary(r), bundle: r.bundle });

export function validateReviewBundle(input: unknown) {
  const bundle = MedicineReviewBundle.parse(input),
    { catalogue, report, provenance } = bundle;
  const source = JSON.stringify(catalogue.source);
  const hashes = Object.fromEntries(
    (Object.keys(FILES) as (keyof typeof FILES)[]).map((f) => [f, provenance.fileSha256[f]]),
  );
  const expected = digest(JSON.stringify({ schemaVersion: 1, source: catalogue.source, hashes }));
  if (
    catalogue.fingerprint !== expected ||
    report.fingerprint !== expected ||
    provenance.fingerprint !== expected ||
    JSON.stringify(report.source) !== source ||
    JSON.stringify(provenance.source) !== source
  )
    throw invalid('The source metadata and fingerprint do not match. Recreate the review bundle.');
  if (
    report.candidateBrands !== catalogue.records.length ||
    report.candidateBrands > report.tables['BrandMaster.txt'].indexedRows ||
    report.candidateBrands + report.rejectedBrands !== report.tables['BrandMaster.txt'].inputRows ||
    Object.values(report.tables).some((t) => t.indexedRows > t.inputRows)
  )
    throw invalid('The candidate and quarantine counts do not match.');
  const rejectedLines = new Set(
    report.issues.filter((i) => i.file === 'BrandMaster.txt').map((i) => i.line),
  );
  if (rejectedLines.size !== report.rejectedBrands)
    throw invalid('Each quarantined brand row needs a report entry.');
  const ids = new Set<string>(),
    names = new Map<string, string>();
  for (const r of catalogue.records) {
    if (ids.has(r.sourceId)) throw invalid('Duplicate candidate identifiers are not allowed.');
    ids.add(r.sourceId);
    const refs = [
      ['product', r.product],
      ['supplier', r.supplier],
      ['generic', r.generic],
      ['form', r.form],
      ...r.ingredients.map((i) => ['ingredient', i] as const),
      ...r.routes.map((i) => ['route', i] as const),
    ] as const;
    for (const [kind, ref] of refs) {
      const key = kind + ':' + ref.sourceId;
      const old = names.get(key);
      if (old && old !== ref.name) throw invalid('A source identifier has conflicting names.');
      names.set(key, ref.name);
    }
  }
  if (report.issues.some((i) => i.file === 'BrandMaster.txt' && ids.has(i.sourceId)))
    throw invalid('A candidate cannot also be quarantined.');
  return bundle;
}

/** Platform-only synthetic catalogue. Never reads/writes medicines or prescriptions. */
export class MedicineReviewService {
  constructor(private s: Services) {}
  private audit(tx: Tx, req: FastifyRequest, operatorId: string, action: string, id?: string) {
    return writeAudit(tx, req, {
      action: 'platform.medicine.' + action,
      organisationId: null,
      actorUserId: null,
      entityType: 'platform_operator',
      entityId: operatorId,
      metadata: id ? { stageId: id } : {},
    });
  }
  private async row(tx: Tx, id: string) {
    const r = await tx.platformMedicineStage.findUnique({ where: { id }, include });
    if (!r) throw new AppError(404, 'NOT_FOUND', 'Catalogue snapshot not found.');
    return r;
  }
  async list(req: FastifyRequest, operatorId: string, cursor?: string, state?: string) {
    return withPlatform(this.s.db, async (tx) => {
      const anchor = cursor ? await this.row(tx, cursor) : null;
      if (anchor && state && anchor.state !== state)
        throw invalid('The cursor does not belong to this state filter. Restart the listing.');
      const rows = await tx.platformMedicineStage.findMany({
        where: {
          ...(state ? { state } : {}),
          ...(anchor
            ? {
                OR: [
                  { createdAt: { lt: anchor.createdAt } },
                  { createdAt: anchor.createdAt, id: { lt: anchor.id } },
                ],
              }
            : {}),
        },
        include,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 21,
      });
      await this.audit(tx, req, operatorId, 'listed');
      return {
        data: rows.slice(0, 20).map(summary),
        nextCursor: rows.length > 20 ? rows[19]!.id : null,
      };
    });
  }
  async read(req: FastifyRequest, operatorId: string, id: string) {
    return withPlatform(this.s.db, async (tx) => {
      const r = await this.row(tx, id);
      await this.audit(tx, req, operatorId, 'viewed', id);
      return detail(r);
    });
  }
  async create(req: FastifyRequest, operatorId: string, input: unknown) {
    const bundle = validateReviewBundle(input),
      source = bundle.catalogue.source,
      bundleHash = digest(JSON.stringify(bundle));
    return withPlatform(this.s.db, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`medicine-stage:${source.datasetKey}:${source.version}`},0))`;
      const existing = await tx.platformMedicineStage.findUnique({
        where: {
          datasetKey_sourceVersion: {
            datasetKey: source.datasetKey,
            sourceVersion: source.version,
          },
        },
        include,
      });
      if (existing) {
        if (existing.bundleHash !== bundleHash) throw conflict();
        await this.audit(tx, req, operatorId, 'upload.replayed', existing.id);
        return { created: false, stage: detail(existing) };
      }
      // Prisma's insert includes default-valued columns. Use an explicit column list
      // so the operator cannot INSERT its own review state or review decision.
      const id = randomUUID();
      await tx.$executeRaw`INSERT INTO platform_medicine_stages
        (id,dataset_key,source_version,fingerprint,bundle_hash,bundle,candidate_count,issue_count,created_by,created_at)
        VALUES (${id}::uuid,${source.datasetKey},${source.version},${bundle.catalogue.fingerprint},
        ${bundleHash},${JSON.stringify(bundle)}::jsonb,${bundle.catalogue.records.length},
        ${bundle.report.issues.length},${operatorId}::uuid,${this.s.now()})`;
      const row = await this.row(tx, id);
      await this.audit(tx, req, operatorId, 'uploaded', row.id);
      return { created: true, stage: detail(row) };
    });
  }
  async review(req: FastifyRequest, operatorId: string, id: string, body: MedicineStageReviewBody) {
    return withPlatform(this.s.db, async (tx) => {
      const changed = await tx.platformMedicineStage.updateMany({
        where: { id, state: 'pending', revision: body.revision },
        data: {
          state: body.decision,
          reviewedBy: operatorId,
          reviewedAt: this.s.now(),
          reviewNote: body.note,
          revision: { increment: 1 },
        },
      });
      if (changed.count !== 1) throw conflict();
      await this.audit(tx, req, operatorId, body.decision, id);
      return detail(await this.row(tx, id));
    });
  }
  async sandbox(req: FastifyRequest, operatorId: string) {
    return withPlatform(this.s.db, async (tx) => {
      const slot = await tx.platformMedicineSandbox.findUnique({
        where: { id: 1 },
        include: { stage: { include } },
      });
      await this.audit(tx, req, operatorId, 'sandbox.viewed');
      return {
        stage: slot ? detail(slot.stage) : null,
        clinicalPublicationAllowed: false as const,
      };
    });
  }
  async publish(
    req: FastifyRequest,
    operatorId: string,
    id: string,
    body: MedicineStagePublishBody,
  ) {
    return withPlatform(this.s.db, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'platform:medicine-sandbox-publication'},0))`;
      const slot = await tx.platformMedicineSandbox.findUnique({ where: { id: 1 } });
      if ((slot?.stageId ?? null) !== body.expectedActiveStageId) throw conflict();
      const changed = await tx.platformMedicineStage.updateMany({
        where: { id, state: { in: ['reviewed', 'published_demo'] }, revision: body.revision },
        data: { state: 'published_demo', revision: { increment: 1 } },
      });
      if (changed.count !== 1) throw conflict();
      await tx.platformMedicineSandbox.upsert({
        where: { id: 1 },
        create: { id: 1, stageId: id, updatedBy: operatorId, updatedAt: this.s.now() },
        update: { stageId: id, updatedBy: operatorId, updatedAt: this.s.now() },
      });
      await this.audit(tx, req, operatorId, 'sandbox.published', id);
      return { stage: detail(await this.row(tx, id)), clinicalPublicationAllowed: false as const };
    });
  }
}
