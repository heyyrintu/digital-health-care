import { z } from 'zod';
import { CursorQuery, page } from './pagination';
import { TagRef } from './tags';

export const Gender = z.enum(['female', 'male', 'other']);
export type Gender = z.infer<typeof Gender>;

export const Language = z.enum(['en', 'hi']);
export type Language = z.infer<typeof Language>;

export const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'] as const;
export const BloodGroup = z.enum(BLOOD_GROUPS);
export type BloodGroup = z.infer<typeof BloodGroup>;

/** Enough to recognise a patient in a list (queue, family, duplicate warning). */
export const PatientRef = z.object({
  id: z.uuid(),
  uhid: z.string(),
  name: z.string(),
});
export type PatientRef = z.infer<typeof PatientRef>;

export const PatientSummary = PatientRef.extend({
  phone: z.string().nullable(),
  /** `YYYY-MM-DD` */
  dob: z.iso.date().nullable(),
  gender: Gender.nullable(),
  tags: z.array(TagRef),
});
export type PatientSummary = z.infer<typeof PatientSummary>;

/** Demographics only: front desk may see all of it. Clinical history lives elsewhere. */
export const PatientDetail = PatientSummary.extend({
  email: z.string().nullable(),
  address: z.string().nullable(),
  bloodGroup: BloodGroup.nullable(),
  language: Language,
  emergencyContactName: z.string().nullable(),
  emergencyContactPhone: z.string().nullable(),
  guardian: PatientRef.nullable(),
  /** Others on the same phone number, the guardian, and dependants. */
  family: z.array(PatientRef.extend({ relation: z.enum(['guardian', 'dependant', 'same_phone']) })),
  createdAt: z.iso.datetime(),
});
export type PatientDetail = z.infer<typeof PatientDetail>;

export const PatientListQuery = CursorQuery.extend({
  /** Matches name, phone or UHID. */
  q: z.string().trim().min(1).max(100).optional(),
  tagId: z.uuid().optional(),
});
export type PatientListQuery = z.infer<typeof PatientListQuery>;

export const PatientListResponse = page(PatientSummary);
export type PatientListResponse = z.infer<typeof PatientListResponse>;

const optionalText = (max: number) => z.string().trim().min(1).max(max).nullable().optional();

/**
 * Demographic fields. On update, omit a field to keep it and send `null` to clear it.
 * Phone numbers are Indian mobiles in any common format; the API stores E.164.
 */
const PatientFields = z.object({
  name: z.string().trim().min(1).max(120),
  phone: optionalText(20),
  /** `YYYY-MM-DD`, not in the future. */
  dob: z.iso.date().nullable().optional(),
  gender: Gender.nullable().optional(),
  email: z.email().max(254).nullable().optional(),
  address: optionalText(300),
  bloodGroup: BloodGroup.nullable().optional(),
  language: Language.optional(),
  emergencyContactName: optionalText(120),
  emergencyContactPhone: optionalText(20),
  /** Adult who looks after this patient (required when the patient has no phone). */
  guardianPatientId: z.uuid().nullable().optional(),
});

export const CreatePatientBody = PatientFields.extend({
  tagIds: z.array(z.uuid()).max(10).optional(),
  /** Register even though possible duplicates were found (the staff member checked). */
  allowDuplicate: z.boolean().default(false),
});
export type CreatePatientBody = z.infer<typeof CreatePatientBody>;

export const UpdatePatientBody = PatientFields.partial();
export type UpdatePatientBody = z.infer<typeof UpdatePatientBody>;

export const DuplicateCheckBody = z.object({
  name: z.string().trim().min(1).max(120),
  phone: optionalText(20),
  dob: z.iso.date().nullable().optional(),
});
export type DuplicateCheckBody = z.infer<typeof DuplicateCheckBody>;

/** Same phone and name, or same name and date of birth. */
export const DuplicateCheckResponse = z.object({ candidates: z.array(PatientSummary) });
export type DuplicateCheckResponse = z.infer<typeof DuplicateCheckResponse>;

export const SetPatientTagsBody = z.object({ tagIds: z.array(z.uuid()).max(20) });
export type SetPatientTagsBody = z.infer<typeof SetPatientTagsBody>;

// ---- UHID numbering (clinic admin) --------------------------------------------------

export const UhidSettings = z.object({
  /** Letters and digits, e.g. `EK`. May be empty. */
  prefix: z.string(),
  nextNumber: z.number().int(),
  /** The UHID the next registered patient gets, e.g. `EK10001`. */
  nextUhid: z.string(),
});
export type UhidSettings = z.infer<typeof UhidSettings>;

export const UpdateUhidSettingsBody = z.object({
  prefix: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{0,8}$/),
  nextNumber: z.number().int().min(1).max(999_999_999),
});
export type UpdateUhidSettingsBody = z.infer<typeof UpdateUhidSettingsBody>;
