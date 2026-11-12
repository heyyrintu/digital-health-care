import { z } from 'zod';
import { Candidate } from './medicine-staging';
import { MedicineRoute } from './prescriptions';

const text = (n: number) => z.string().trim().min(1).max(n);
export const ClinicalIngredientMapping = z
  .object({
    sourceId: z.string().regex(/^\d{1,18}$/),
    canonicalName: text(200).nullable(),
    strengthStatus: z.enum(['unmapped', 'mapped', 'not_applicable']),
    value: z.number().positive().max(1_000_000).nullable(),
    unit: z.enum(['mg', 'g', 'microgram', 'IU', 'percent']).nullable(),
    per: z.enum(['unit', 'ml']).nullable(),
    reason: text(1000).nullable(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const fields = [v.value, v.unit, v.per];
    if (
      v.strengthStatus === 'mapped'
        ? v.value === null ||
          v.unit === null ||
          (v.unit === 'percent' ? v.per !== null : v.per === null)
        : fields.some((x) => x !== null)
    )
      ctx.addIssue({
        code: 'custom',
        message:
          'Mapped strengths need value and unit; non-percentage strengths also need a denominator. Other states leave numeric fields blank.',
      });
    if (
      v.strengthStatus === 'mapped' &&
      v.unit === 'percent' &&
      ((v.value ?? 0) > 100 || !v.reason || v.reason.length < 10)
    )
      ctx.addIssue({
        code: 'custom',
        message:
          'Percentages require a value up to 100 and explicit evidence of their concentration basis; no extra denominator.',
      });
    if (v.strengthStatus === 'not_applicable' && (!v.reason || v.reason.length < 10))
      ctx.addIssue({
        code: 'custom',
        message: 'Explain why a numeric strength is not applicable.',
      });
  });
export const ClinicalMapping = z
  .object({
    form: text(40).nullable(),
    route: MedicineRoute.nullable(),
    ingredients: z.array(ClinicalIngredientMapping).min(1).max(100),
    regulatoryEvidence: text(2000).nullable(),
    notes: z.string().trim().max(2000),
    decision: z.enum(['draft', 'review_recorded']),
    reviewerName: text(200).nullable(),
    reviewerRegistration: text(200).nullable(),
    reviewAttested: z.boolean(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (new Set(v.ingredients.map((i) => i.sourceId)).size !== v.ingredients.length)
      ctx.addIssue({ code: 'custom', message: 'Map each source ingredient exactly once.' });
    if (
      v.decision === 'review_recorded' &&
      (!v.form ||
        !v.route ||
        !v.regulatoryEvidence ||
        !v.reviewerName ||
        !v.reviewerRegistration ||
        !v.reviewAttested ||
        v.notes.length < 10 ||
        v.ingredients.some((i) => !i.canonicalName || i.strengthStatus === 'unmapped'))
    )
      ctx.addIssue({
        code: 'custom',
        message:
          'Complete the mappings, evidence and clinician attestation before recording review.',
      });
  });
export type ClinicalMapping = z.infer<typeof ClinicalMapping>;
export const SaveClinicalMapping = z
  .object({ revision: z.number().int().nonnegative(), mapping: ClinicalMapping })
  .strict();
export const ImportReleaseSummary = z.object({
  id: z.uuid(),
  datasetKey: z.string(),
  sourceVersion: z.string(),
  fingerprint: z.string(),
  dataKind: z.enum(['real', 'synthetic']),
  brandCount: z.number().int(),
  genericCount: z.number().int(),
  issueCount: z.number().int(),
  createdAt: z.iso.datetime(),
  licenceStatus: z.literal('pending'),
  clinicalPublicationAllowed: z.literal(false),
});
export type ImportReleaseSummary = z.infer<typeof ImportReleaseSummary>;
export const ImportReleaseList = z.object({
  data: z.array(ImportReleaseSummary),
  nextCursor: z.uuid().nullable(),
});
export const ImportGeneric = z.object({
  releaseId: z.uuid(),
  sourceId: z.string(),
  name: z.string(),
  source: Candidate.pick({ generic: true, ingredients: true, routes: true, form: true }),
  revision: z.number().int().nonnegative(),
  mapping: ClinicalMapping.nullable(),
});
export type ImportGeneric = z.infer<typeof ImportGeneric>;
export const ImportGenericList = z.object({
  data: z.array(ImportGeneric),
  nextCursor: z.string().nullable(),
});
export const ImportBrandList = z.object({
  data: z.array(Candidate),
  nextCursor: z.string().nullable(),
});
export type ImportBrandList = z.infer<typeof ImportBrandList>;
export const ImportPageQuery = z.object({
  cursor: z
    .string()
    .regex(/^\d{1,18}$/)
    .optional(),
  q: z.string().trim().max(100).optional(),
});
export const ImportMappingHistory = z.object({
  data: z.array(
    z.object({
      revision: z.number().int().positive(),
      mapping: ClinicalMapping,
      recordedAt: z.iso.datetime(),
      recordedBy: z.string(),
    }),
  ),
  nextBefore: z.number().int().positive().nullable(),
});
export type ImportMappingHistory = z.infer<typeof ImportMappingHistory>;
