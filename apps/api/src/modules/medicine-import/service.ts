import {
  ClinicalMapping,
  ImportGeneric,
  ImportReleaseSummary,
  SaveClinicalMapping,
} from '@dhc/contracts';
import { withPlatform, type Db, type Tx } from '@dhc/db';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../../errors';
import { writeAudit } from '../audit/write';

const notFound = () => new AppError(404, 'NOT_FOUND', 'Imported release or generic not found.');
export class MedicineImportService {
  constructor(private db: Db) {}
  private audit(
    tx: Tx,
    req: FastifyRequest,
    operatorId: string,
    action: string,
    releaseId?: string,
    sourceId?: string,
    revision?: number,
  ) {
    return writeAudit(tx, req, {
      action: 'platform.medicine.import.' + action,
      entityType: 'platform_operator',
      entityId: operatorId,
      metadata: {
        ...(releaseId ? { releaseId } : {}),
        ...(sourceId ? { sourceId } : {}),
        ...(revision !== undefined ? { revision } : {}),
      },
    });
  }
  async list(req: FastifyRequest, operatorId: string, cursor?: string) {
    return withPlatform(this.db, async (tx) => {
      const rows = await tx.medicineImportRelease.findMany({
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        take: 21,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      await this.audit(tx, req, operatorId, 'listed');
      return {
        data: rows.slice(0, 20).map((r) =>
          ImportReleaseSummary.parse({
            ...r,
            createdAt: r.createdAt.toISOString(),
            licenceStatus: 'pending',
            clinicalPublicationAllowed: false,
          }),
        ),
        nextCursor: rows.length > 20 ? rows[19]!.id : null,
      };
    });
  }
  async generics(
    req: FastifyRequest,
    operatorId: string,
    releaseId: string,
    cursor?: string,
    q?: string,
  ) {
    return withPlatform(this.db, async (tx) => {
      if (!(await tx.medicineImportRelease.count({ where: { id: releaseId } }))) throw notFound();
      const rows = await tx.medicineImportGeneric.findMany({
        where: {
          releaseId,
          ...(cursor ? { sourceId: { gt: cursor } } : {}),
          ...(q
            ? {
                OR: [
                  { name: { contains: q, mode: 'insensitive' } },
                  { sourceId: { contains: q } },
                  {
                    brands: {
                      some: {
                        OR: [
                          { name: { contains: q, mode: 'insensitive' } },
                          { sourceId: { contains: q } },
                        ],
                      },
                    },
                  },
                ],
              }
            : {}),
        },
        orderBy: { sourceId: 'asc' },
        take: 26,
      });
      await this.audit(tx, req, operatorId, 'generics.viewed', releaseId);
      return {
        data: rows.slice(0, 25).map((r) => ImportGeneric.parse(r)),
        nextCursor: rows.length > 25 ? rows[24]!.sourceId : null,
      };
    });
  }
  async brands(
    req: FastifyRequest,
    operatorId: string,
    releaseId: string,
    sourceId: string,
    cursor?: string,
  ) {
    return withPlatform(this.db, async (tx) => {
      if (!(await tx.medicineImportGeneric.count({ where: { releaseId, sourceId } })))
        throw notFound();
      const rows = await tx.medicineImportBrand.findMany({
        where: { releaseId, genericId: sourceId, ...(cursor ? { sourceId: { gt: cursor } } : {}) },
        orderBy: { sourceId: 'asc' },
        take: 26,
      });
      await this.audit(tx, req, operatorId, 'brands.viewed', releaseId, sourceId);
      return {
        data: rows.slice(0, 25).map((r) => r.source),
        nextCursor: rows.length > 25 ? rows[24]!.sourceId : null,
      };
    });
  }
  async history(
    req: FastifyRequest,
    operatorId: string,
    releaseId: string,
    sourceId: string,
    before?: number,
  ) {
    return withPlatform(this.db, async (tx) => {
      if (!(await tx.medicineImportGeneric.count({ where: { releaseId, sourceId } })))
        throw notFound();
      const rows = await tx.medicineImportMapping.findMany({
        where: { releaseId, sourceId, ...(before ? { revision: { lt: before } } : {}) },
        orderBy: { revision: 'desc' },
        take: 26,
        include: { recorder: { select: { displayName: true } } },
      });
      await this.audit(tx, req, operatorId, 'mapping.history', releaseId, sourceId);
      return {
        data: rows.slice(0, 25).map((r) => ({
          revision: r.revision,
          mapping: ClinicalMapping.parse(r.mapping),
          recordedAt: r.recordedAt.toISOString(),
          recordedBy: r.recorder.displayName,
        })),
        nextBefore: rows.length > 25 ? rows[24]!.revision : null,
      };
    });
  }
  async save(
    req: FastifyRequest,
    operatorId: string,
    releaseId: string,
    sourceId: string,
    raw: unknown,
  ) {
    const input = SaveClinicalMapping.parse(raw);
    return withPlatform(this.db, async (tx) => {
      const row = await tx.medicineImportGeneric.findUnique({
        where: { releaseId_sourceId: { releaseId, sourceId } },
      });
      if (!row) throw notFound();
      const generic = ImportGeneric.parse(row);
      const expected = generic.source.ingredients.map((i) => i.sourceId).sort();
      const actual = input.mapping.ingredients.map((i) => i.sourceId).sort();
      if (JSON.stringify(expected) !== JSON.stringify(actual))
        throw new AppError(
          400,
          'VALIDATION_FAILED',
          'Map exactly the source ingredients; additions and omissions are not allowed.',
        );
      const updated = await tx.medicineImportGeneric.updateMany({
        where: { releaseId, sourceId, revision: input.revision },
        data: { mapping: input.mapping, revision: { increment: 1 } },
      });
      if (updated.count !== 1)
        throw new AppError(409, 'CONFLICT', 'This mapping changed. Reload before saving.');
      const revision = input.revision + 1;
      await tx.medicineImportMapping.create({
        data: { releaseId, sourceId, revision, mapping: input.mapping, recordedBy: operatorId },
      });
      await this.audit(tx, req, operatorId, 'mapping.saved', releaseId, sourceId, revision);
      return ImportGeneric.parse({ ...row, revision, mapping: input.mapping });
    });
  }
}
