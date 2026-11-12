import { z } from 'zod';
export const Manifest = z
  .object({
    format: z.literal('cdci-flat-files/v1'),
    dataKind: z.literal('synthetic'),
    datasetKey: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/),
    version: z.string().trim().min(1).max(80),
  })
  .strict();
export type Manifest = z.infer<typeof Manifest>;
const identifier = z.string().regex(/^\d{1,18}$/);
const namedReference = z.object({ sourceId: identifier, name: z.string().trim().min(1) }).strict();
export const Candidate = z
  .object({
    sourceId: identifier,
    name: z.string().trim().min(1),
    product: namedReference,
    supplier: namedReference,
    generic: namedReference,
    ingredients: z.array(namedReference).min(1),
    routes: z.array(namedReference).min(1),
    form: namedReference,
    sourceUpdatedAt: z.iso.date().nullable(),
    regulatoryStatus: z.string().trim().min(1),
    clinicalSafety: z.literal('not_assessed'),
    reviewRequired: z.tuple([
      z.literal('strength_mapping'),
      z.literal('route_mapping'),
      z.literal('clinical_review'),
      z.literal('regulatory_review'),
    ]),
  })
  .strict();
export type Candidate = z.infer<typeof Candidate>;
export const Catalogue = z
  .object({
    schemaVersion: z.literal(1),
    source: Manifest,
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    publicationAllowed: z.literal(false),
    records: z.array(Candidate).max(200_000),
  })
  .strict();
export type Catalogue = z.infer<typeof Catalogue>;

export const MedicineStageFile = z.enum([
  'SubstanceMaster.txt',
  'ProductMaster.txt',
  'SupplierMaster.txt',
  'DrugFormMaster.txt',
  'RouteOfAdministrationMaster.txt',
  'GenericMaster.txt',
  'BrandMaster.txt',
]);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
export const MedicineReviewBundle = z
  .object({
    catalogue: Catalogue.extend({ records: z.array(Candidate).min(1).max(500) }),
    report: z
      .object({
        fingerprint: sha,
        source: Manifest,
        publicationAllowed: z.literal(false),
        tables: z.record(
          MedicineStageFile,
          z
            .object({
              inputRows: z.number().int().min(0).max(200_000),
              indexedRows: z.number().int().min(0).max(200_000),
            })
            .strict(),
        ),
        candidateBrands: z.number().int().min(1).max(500),
        rejectedBrands: z.number().int().min(0).max(200_000),
        issues: z
          .array(
            z
              .object({
                file: MedicineStageFile,
                line: z.number().int().min(1),
                sourceId: z.string().max(100),
                reason: z.string().min(1).max(200),
              })
              .strict(),
          )
          .max(2000),
        clinicalSafety: z.literal('not_assessed'),
      })
      .strict(),
    provenance: z
      .object({
        schemaVersion: z.literal(1),
        source: Manifest,
        fingerprint: sha,
        fileSha256: z.record(MedicineStageFile, sha),
      })
      .strict(),
  })
  .strict();
export type MedicineReviewBundle = z.infer<typeof MedicineReviewBundle>;
export const MedicineStageState = z.enum(['pending', 'reviewed', 'rejected', 'published_demo']);
export const MedicineStageSummary = z.object({
  id: z.uuid(),
  datasetKey: z.string(),
  sourceVersion: z.string(),
  fingerprint: sha,
  revision: z.number().int().positive(),
  state: MedicineStageState,
  candidateCount: z.number().int().min(1),
  issueCount: z.number().int().min(0),
  createdAt: z.iso.datetime(),
  reviewedAt: z.iso.datetime().nullable(),
  reviewerName: z.string().nullable(),
  reviewNote: z.string().nullable(),
});
export type MedicineStageSummary = z.infer<typeof MedicineStageSummary>;
export const MedicineStageDetail = MedicineStageSummary.extend({ bundle: MedicineReviewBundle });
export type MedicineStageDetail = z.infer<typeof MedicineStageDetail>;
export const MedicineStageList = z.object({
  data: z.array(MedicineStageSummary),
  nextCursor: z.uuid().nullable(),
});
export const MedicineStageQuery = z.object({
  cursor: z.uuid().optional(),
  state: MedicineStageState.optional(),
});
export const MedicineStageReviewBody = z
  .object({
    revision: z.number().int().positive(),
    decision: z.enum(['reviewed', 'rejected']),
    note: z.string().trim().min(10).max(1000),
    scopeAcknowledged: z.literal(true),
  })
  .strict();
export const MedicineStagePublishBody = z
  .object({ revision: z.number().int().positive(), expectedActiveStageId: z.uuid().nullable() })
  .strict();
export const MedicineSandboxView = z.object({
  stage: MedicineStageDetail.nullable(),
  clinicalPublicationAllowed: z.literal(false),
});
export type MedicineStageReviewBody = z.infer<typeof MedicineStageReviewBody>;
export type MedicineStagePublishBody = z.infer<typeof MedicineStagePublishBody>;
