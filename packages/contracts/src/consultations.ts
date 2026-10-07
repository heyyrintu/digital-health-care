import { z } from 'zod';
import { Appointment } from './appointments';

// ---- Patient chart (PRD §6.1 context panel) -----------------------------------------

/** Patient-reported entries are labelled unverified until a doctor confirms them. */
export const ChartSource = z.enum(['doctor', 'patient']);
export type ChartSource = z.infer<typeof ChartSource>;

const chartEntry = {
  id: z.uuid(),
  source: ChartSource,
  createdAt: z.iso.datetime(),
  recordedByName: z.string().nullable(),
};

export const Allergy = z.object({
  ...chartEntry,
  substance: z.string(),
  reaction: z.string().nullable(),
});
export type Allergy = z.infer<typeof Allergy>;

export const MedicalCondition = z.object({
  ...chartEntry,
  name: z.string(),
  icd10Code: z.string().nullable(),
});
export type MedicalCondition = z.infer<typeof MedicalCondition>;

export const CurrentMedication = z.object({
  ...chartEntry,
  name: z.string(),
  dose: z.string().nullable(),
});
export type CurrentMedication = z.infer<typeof CurrentMedication>;

const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();

export const CreateAllergyBody = z.object({
  substance: z.string().trim().min(1).max(120),
  reaction: optionalText(200),
  source: ChartSource.default('doctor'),
});
export type CreateAllergyBody = z.infer<typeof CreateAllergyBody>;

export const CreateConditionBody = z.object({
  name: z.string().trim().min(1).max(200),
  icd10Code: z
    .string()
    .trim()
    .regex(/^[A-Z][0-9]{2}(\.[0-9A-Z]{1,4})?$/, 'Use an ICD-10 code such as M17.1')
    .nullable()
    .optional(),
  source: ChartSource.default('doctor'),
});
export type CreateConditionBody = z.infer<typeof CreateConditionBody>;

export const CreateMedicationBody = z.object({
  name: z.string().trim().min(1).max(200),
  dose: optionalText(120),
  source: ChartSource.default('doctor'),
});
export type CreateMedicationBody = z.infer<typeof CreateMedicationBody>;

/** Chart entries are never deleted; removing one keeps it with who, when and why. */
export const RemoveChartEntryBody = z.object({ reason: z.string().trim().min(1).max(300) });
export type RemoveChartEntryBody = z.infer<typeof RemoveChartEntryBody>;

export const Diagnosis = z.object({
  /** ICD-10 code, when picked from the list; free-text diagnoses have none. */
  code: z.string().trim().max(10).nullable(),
  label: z.string().trim().min(1).max(200),
});
export type Diagnosis = z.infer<typeof Diagnosis>;

/** A previous visit as the context panel lists it. */
export const RecentVisit = z.object({
  appointmentId: z.uuid(),
  date: z.iso.date(),
  doctorName: z.string().nullable(),
  chiefComplaint: z.string(),
  diagnoses: z.array(Diagnosis),
});
export type RecentVisit = z.infer<typeof RecentVisit>;

export const PatientChart = z.object({
  patientId: z.uuid(),
  allergies: z.array(Allergy),
  conditions: z.array(MedicalCondition),
  medications: z.array(CurrentMedication),
  /** The last five completed visits that have a consultation record, newest first. */
  recentVisits: z.array(RecentVisit),
});
export type PatientChart = z.infer<typeof PatientChart>;

// ---- Vitals -------------------------------------------------------------------------

export const PregnancyStatus = z.enum(['not_pregnant', 'pregnant', 'breastfeeding']);
export type PregnancyStatus = z.infer<typeof PregnancyStatus>;

const reading = (min: number, max: number, int = true) =>
  (int ? z.number().int() : z.number()).min(min).max(max).nullable().optional();

/** Every field optional: front desk records what it measured; blanks stay blank. */
export const VitalsBody = z.object({
  bpSystolic: reading(40, 300),
  bpDiastolic: reading(20, 200),
  pulse: reading(20, 250),
  temperatureC: reading(30, 45, false),
  spo2: reading(50, 100),
  weightKg: reading(0.3, 400, false),
  heightCm: reading(20, 250, false),
  painScore: reading(0, 10),
  pregnancyStatus: PregnancyStatus.nullable().optional(),
});
export type VitalsBody = z.infer<typeof VitalsBody>;

export const Vitals = z.object({
  bpSystolic: z.number().int().nullable(),
  bpDiastolic: z.number().int().nullable(),
  pulse: z.number().int().nullable(),
  temperatureC: z.number().nullable(),
  spo2: z.number().int().nullable(),
  weightKg: z.number().nullable(),
  heightCm: z.number().nullable(),
  painScore: z.number().int().nullable(),
  pregnancyStatus: PregnancyStatus.nullable(),
  /** Worked out from weight and height when both are recorded. */
  bmi: z.number().nullable(),
  recordedByName: z.string().nullable(),
  updatedAt: z.iso.datetime(),
});
export type Vitals = z.infer<typeof Vitals>;

export const VitalsResponse = z.object({ vitals: Vitals.nullable() });
export type VitalsResponse = z.infer<typeof VitalsResponse>;

// ---- Consultation -------------------------------------------------------------------

export const Symptom = z.object({
  text: z.string().trim().min(1).max(200),
  duration: z.string().trim().max(60).nullable(),
});
export type Symptom = z.infer<typeof Symptom>;

/** The doctor's notes for one visit. Stored encrypted as one document. */
export const ConsultationNotes = z.object({
  chiefComplaint: z.string().max(500).default(''),
  symptoms: z.array(Symptom).max(20).default([]),
  examination: z.string().max(4000).default(''),
  diagnoses: z.array(Diagnosis).max(10).default([]),
  plan: z.string().max(4000).default(''),
  /** Seen only by doctors; never printed or shared with the patient. */
  privateNotes: z.string().max(4000).default(''),
  testsAdvised: z.string().max(2000).default(''),
  advice: z.string().max(4000).default(''),
});
export type ConsultationNotes = z.infer<typeof ConsultationNotes>;

export const ConsultationRecord = z.object({
  id: z.uuid(),
  doctorUserId: z.uuid(),
  notes: ConsultationNotes,
  followUpDate: z.iso.date().nullable(),
  /** Increases on every save; send it back so a stale tab cannot overwrite newer notes. */
  revision: z.number().int().positive(),
  updatedAt: z.iso.datetime(),
  /** Set when the prescription is signed; the notes can no longer change. */
  lockedAt: z.iso.datetime().nullable(),
});
export type ConsultationRecord = z.infer<typeof ConsultationRecord>;

/** Everything the consultation screen needs for one appointment. */
export const ConsultationView = z.object({
  appointment: Appointment,
  /** Null until the doctor first saves. */
  consultation: ConsultationRecord.nullable(),
  vitals: Vitals.nullable(),
  /** True when the signed-in doctor may write these notes (it is their appointment). */
  canEdit: z.boolean(),
});
export type ConsultationView = z.infer<typeof ConsultationView>;

export const SaveConsultationBody = z.object({
  notes: ConsultationNotes,
  followUpDate: z.iso.date().nullable(),
  /** The revision this edit started from; 0 for the first save. */
  revision: z.number().int().min(0),
});
export type SaveConsultationBody = z.infer<typeof SaveConsultationBody>;
