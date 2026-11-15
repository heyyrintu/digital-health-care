import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Db, Prisma } from '@dhc/db';
import type { stageImportCatalogue } from '../medicine-staging/catalogue';
import { writeAudit, type AuditSource } from '../audit/write';

export type ImportSource = ReturnType<typeof stageImportCatalogue>;
const sha = z.string().regex(/^[a-f0-9]{64}$/);
/** Owner-only, bounded batch ingestion. Nothing here writes clinical medicine tables. */
export async function importMedicineRelease(
  db: Db,
  parsed: ImportSource,
  input: {
    operatorId: string;
    packageSha256: string;
    licenceTextSha256: string;
    audit: AuditSource;
  },
) {
  sha.parse(input.packageSha256);
  sha.parse(input.licenceTextSha256);
  if (!parsed.sourceRows || !parsed.genericRecords || !parsed.catalogue.records.length)
    throw new Error('Parse the complete source package with source rows before importing.');
  const { catalogue, report, provenance, sourceRows, genericRecords } = parsed;
  const source = catalogue.source;
  return db.$transaction(
    async (tx) => {
      const actor = await tx.platformOperator.findUnique({ where: { id: input.operatorId } });
      if (!actor || actor.status !== 'active')
        throw new Error('An active platform operator must own this import.');
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`full-medicine-import:${source.datasetKey}:${source.version}`},0))`;
      const existing = await tx.medicineImportRelease.findUnique({
        where: {
          datasetKey_sourceVersion: {
            datasetKey: source.datasetKey,
            sourceVersion: source.version,
          },
        },
      });
      if (existing) {
        if (
          existing.fingerprint !== catalogue.fingerprint ||
          existing.packageSha256 !== input.packageSha256 ||
          existing.licenceTextSha256 !== input.licenceTextSha256
        )
          throw new Error(
            'This dataset version already contains different source bytes. Use a new version.',
          );
        await writeAudit(tx, input.audit, {
          action: 'platform.medicine.import.replayed',
          entityType: 'platform_operator',
          entityId: actor.id,
          metadata: { releaseId: existing.id },
        });
        return {
          releaseId: existing.id,
          created: false,
          brandCount: existing.brandCount,
          genericCount: existing.genericCount,
          sourceRows: sourceRows.length,
          issueCount: existing.issueCount,
          clinicalPublicationAllowed: false,
        };
      }
      const id = randomUUID();
      await tx.medicineImportRelease.create({
        data: {
          id,
          datasetKey: source.datasetKey,
          sourceVersion: source.version,
          dataKind: source.dataKind,
          fingerprint: catalogue.fingerprint,
          packageSha256: input.packageSha256,
          licenceTextSha256: input.licenceTextSha256,
          report,
          provenance,
          brandCount: catalogue.records.length,
          genericCount: genericRecords.length,
          issueCount: report.issues.length,
          createdBy: actor.id,
        },
      });
      // Batches cap SQL payload/parameter count. No expanded full-release JSON serialization.
      for (let i = 0; i < sourceRows.length; i += 250)
        await tx.medicineImportSourceRow.createMany({
          data: sourceRows.slice(i, i + 250).map((r) => ({
            releaseId: id,
            file: r.file,
            sourceId: r.sourceId,
            name: r.name,
            values: r.values,
          })),
        });
      for (let i = 0; i < genericRecords.length; i += 250)
        await tx.medicineImportGeneric.createMany({
          data: genericRecords.slice(i, i + 250).map((r) => ({
            releaseId: id,
            sourceId: r.generic.sourceId,
            name: r.generic.name,
            source: r,
          })),
        });
      for (let i = 0; i < catalogue.records.length; i += 250)
        await tx.medicineImportBrand.createMany({
          data: catalogue.records.slice(i, i + 250).map((r) => ({
            releaseId: id,
            sourceId: r.sourceId,
            genericId: r.generic.sourceId,
            name: r.name,
            source: r as unknown as Prisma.InputJsonValue,
          })),
        });
      await writeAudit(tx, input.audit, {
        action: 'platform.medicine.import.completed',
        entityType: 'platform_operator',
        entityId: actor.id,
        metadata: {
          releaseId: id,
          brandCount: catalogue.records.length,
          genericCount: genericRecords.length,
          sourceRowCount: sourceRows.length,
          issueCount: report.issues.length,
        },
      });
      return {
        releaseId: id,
        created: true,
        brandCount: catalogue.records.length,
        genericCount: genericRecords.length,
        sourceRows: sourceRows.length,
        issueCount: report.issues.length,
        clinicalPublicationAllowed: false,
      };
    },
    { maxWait: 10_000, timeout: 300_000 },
  );
}
