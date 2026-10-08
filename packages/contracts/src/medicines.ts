import { z } from 'zod';
import { Medicine, MedicineRoute } from './prescriptions';

// The medicine master and the approval queue for free-text medicines (PRD §9.2). Clinic
// admins only; doctors search the master from the prescription builder.

const text = (max: number) => z.string().trim().min(1).max(max);

export const StrengthPer = z.enum(['unit', 'ml']);
export type StrengthPer = z.infer<typeof StrengthPer>;

/** A molecule from the reference drug data with its strength, so safety checks see it. */
export const IngredientInput = z
  .object({
    moleculeId: z.uuid(),
    /** mg per tablet, capsule or drop (`unit`) or per ml; null for creams and IU. */
    strengthMg: z.number().positive().max(1_000_000).nullable(),
    per: StrengthPer.nullable(),
  })
  .refine((i) => (i.strengthMg === null) === (i.per === null), {
    message: 'A strength needs its unit (per tablet or per ml), and the other way round.',
    path: ['per'],
  });
export type IngredientInput = z.infer<typeof IngredientInput>;

export const SaveMedicineBody = z
  .object({
    name: text(120),
    genericName: text(200),
    composition: text(300),
    form: text(40),
    defaultRoute: MedicineRoute,
    /** Without ingredients the safety checks cannot see the medicine (SR-22 says so). */
    ingredients: z.array(IngredientInput).max(10),
  })
  .refine((b) => new Set(b.ingredients.map((i) => i.moleculeId)).size === b.ingredients.length, {
    message: 'Each molecule once.',
    path: ['ingredients'],
  });
export type SaveMedicineBody = z.infer<typeof SaveMedicineBody>;

export const UpdateMedicineBody = SaveMedicineBody.and(z.object({ active: z.boolean() }));
export type UpdateMedicineBody = z.infer<typeof UpdateMedicineBody>;

export const MasterMedicine = Medicine.extend({
  active: z.boolean(),
  ingredients: z.array(
    z.object({
      moleculeId: z.uuid(),
      moleculeName: z.string(),
      strengthMg: z.number().nullable(),
      per: StrengthPer.nullable(),
    }),
  ),
});
export type MasterMedicine = z.infer<typeof MasterMedicine>;

export const MasterMedicineQuery = z.object({
  q: z.string().trim().max(60).optional(),
  source: z.enum(['reference', 'clinic']).optional(),
  includeInactive: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});
export type MasterMedicineQuery = z.infer<typeof MasterMedicineQuery>;

export const MasterMedicineList = z.object({
  data: z.array(MasterMedicine),
  /** More match than are shown: narrow the search. */
  hasMore: z.boolean(),
});
export type MasterMedicineList = z.infer<typeof MasterMedicineList>;

export const DrugMoleculeQuery = z.object({ q: z.string().trim().min(2).max(60) });
export type DrugMoleculeQuery = z.infer<typeof DrugMoleculeQuery>;

export const DrugMoleculeList = z.object({
  data: z.array(z.object({ id: z.uuid(), name: z.string(), drugClass: z.string().nullable() })),
});
export type DrugMoleculeList = z.infer<typeof DrugMoleculeList>;

/** How often a free-text name has been prescribed in this clinic. */
const Usage = {
  name: z.string(),
  /** Lower case with single spaces: the same medicine typed differently is one entry. */
  nameKey: z.string(),
  prescriptions: z.number().int().min(0),
  doctors: z.number().int().min(0),
  lastUsedAt: z.iso.datetime().nullable(),
};

export const MedicineDecisionRow = z.object({
  id: z.uuid(),
  ...Usage,
  decision: z.enum(['approved', 'rejected']),
  medicine: z.object({ id: z.uuid(), name: z.string(), composition: z.string() }).nullable(),
  reason: z.string().nullable(),
  decidedAt: z.iso.datetime(),
  decidedByName: z.string().nullable(),
});
export type MedicineDecisionRow = z.infer<typeof MedicineDecisionRow>;

export const MedicineQueue = z.object({
  /** Free-text names with no decision yet, most used first. */
  pending: z.array(z.object(Usage)),
  decided: z.array(MedicineDecisionRow),
});
export type MedicineQueue = z.infer<typeof MedicineQueue>;

/** Approve a free-text name: map it to a medicine in the master, or add it as a new one. */
export const ApproveMedicineRequestBody = z
  .object({
    name: text(200),
    medicineId: z.uuid().optional(),
    medicine: SaveMedicineBody.optional(),
  })
  .refine((b) => (b.medicineId === undefined) !== (b.medicine === undefined), {
    message: 'Choose an existing medicine or add a new one.',
    path: ['medicineId'],
  });
export type ApproveMedicineRequestBody = z.infer<typeof ApproveMedicineRequestBody>;

export const RejectMedicineRequestBody = z.object({ name: text(200), reason: text(300) });
export type RejectMedicineRequestBody = z.infer<typeof RejectMedicineRequestBody>;

/** A 204 response has no body; clients parse it with this. */
export const NoContent = z.undefined();
