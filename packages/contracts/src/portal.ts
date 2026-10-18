import { z } from 'zod';
import { AppointmentStatus } from './appointments';
import { Gender, Language } from './patients';
import { ConsultationMode, SlotsQuery } from './scheduling';

/**
 * The Patient app and web portal (PRD §4): one phone number is one account, and an account
 * holds several patients (a family). The account's patients are the records whose mobile is
 * the number the person verified by OTP, and the dependants linked to them, so a record the
 * clinic registered earlier is claimed simply by signing in with its number.
 */

/** Documents accepted at onboarding (PRD §4.1, C9). Health data is a separate consent. */
export const ACCOUNT_CONSENT_KINDS = ['privacy_notice', 'terms', 'health_data'] as const;
export const AccountConsentKind = z.enum(ACCOUNT_CONSENT_KINDS);
export type AccountConsentKind = z.infer<typeof AccountConsentKind>;

/**
 * The versions in force. Raising one asks every patient to accept it again before using the
 * app; the accepted version is kept with each acceptance.
 */
export const CURRENT_CONSENT_VERSIONS: Record<AccountConsentKind, string> = {
  privacy_notice: '2026-10',
  terms: '2026-10',
  health_data: '2026-10',
};

export const AccountConsent = z.object({
  kind: AccountConsentKind,
  version: z.string(),
  acceptedAt: z.iso.datetime(),
  /** Set when the person withdrew it; withdrawn consents stay on record. */
  withdrawnAt: z.iso.datetime().nullable(),
});
export type AccountConsent = z.infer<typeof AccountConsent>;

export const ConsentStatus = z.object({
  /** Each kind's acceptance in force, else its latest one; newest first. */
  consents: z.array(AccountConsent),
  /** Kinds still to accept (never accepted, withdrawn, or an older version). */
  pending: z.array(AccountConsentKind),
});
export type ConsentStatus = z.infer<typeof ConsentStatus>;

export const AcceptConsentsBody = z.object({
  /** Each kind with the version the person was shown; it must be the current one. */
  accept: z
    .array(z.object({ kind: AccountConsentKind, version: z.string().min(1).max(20) }))
    .min(1)
    .max(ACCOUNT_CONSENT_KINDS.length),
});
export type AcceptConsentsBody = z.infer<typeof AcceptConsentsBody>;

/** How a patient belongs to the signed-in account. */
export const PortalRelation = z.enum([
  /** The record's mobile is the account's number (the person, or family sharing it). */
  'account',
  /** No mobile of their own; looked after by one of the account's patients. */
  'dependant',
]);
export type PortalRelation = z.infer<typeof PortalRelation>;

export const PortalPatient = z.object({
  id: z.uuid(),
  uhid: z.string(),
  name: z.string(),
  /** `YYYY-MM-DD` */
  dob: z.iso.date().nullable(),
  gender: Gender.nullable(),
  language: Language,
  relation: PortalRelation,
  /** For dependants, the account patient who looks after them. */
  guardianPatientId: z.uuid().nullable(),
});
export type PortalPatient = z.infer<typeof PortalPatient>;

export const PortalPatientList = z.object({ data: z.array(PortalPatient) });
export type PortalPatientList = z.infer<typeof PortalPatientList>;

/**
 * Adds a patient to the account. Without `guardianPatientId` the record takes the account's
 * mobile (the person themself, or an adult sharing the number); with it, a dependant without
 * a mobile, looked after by that account patient.
 */
export const CreatePortalPatientBody = z.object({
  name: z.string().trim().min(1).max(120),
  /** `YYYY-MM-DD`, not in the future. */
  dob: z.iso.date(),
  gender: Gender,
  language: Language.optional(),
  guardianPatientId: z.uuid().optional(),
});
export type CreatePortalPatientBody = z.infer<typeof CreatePortalPatientBody>;

// ---- Booking, appointments and prescriptions (PRD §4.3, §4.4) -------------------------

/** What a patient can book: in-person consultations without payment at booking, for now. */
export const BookingOptions = z.object({
  doctors: z.array(
    z.object({
      userId: z.uuid(),
      displayName: z.string().nullable(),
      /** The doctor's public page address when it is listed: `/app/book?doctor=<slug>` picks them. */
      publicSlug: z.string().nullable(),
    }),
  ),
  clinics: z.array(z.object({ id: z.uuid(), name: z.string(), address: z.string().nullable() })),
  consultationTypes: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      mode: ConsultationMode,
      defaultDurationMin: z.number().int(),
      feePaise: z.number().int(),
    }),
  ),
  horizonDays: z.number().int(),
  cancelCutoffMinutes: z.number().int(),
  maxActiveBookings: z.number().int(),
});
export type BookingOptions = z.infer<typeof BookingOptions>;

export const PortalSlotsQuery = SlotsQuery.omit({ channel: true });
export type PortalSlotsQuery = z.infer<typeof PortalSlotsQuery>;

export const PortalBookBody = z.object({
  patientId: z.uuid(),
  doctorUserId: z.uuid(),
  clinicId: z.uuid(),
  consultationTypeId: z.uuid(),
  startAt: z.iso.datetime(),
  reason: z.string().trim().min(1).max(300).optional(),
});
export type PortalBookBody = z.infer<typeof PortalBookBody>;

export const PortalCancelBody = z.object({
  reason: z.string().trim().min(1).max(300).optional(),
});
export type PortalCancelBody = z.infer<typeof PortalCancelBody>;

export const PortalPrescriptionRef = z.object({
  id: z.uuid(),
  number: z.string(),
  version: z.number().int(),
  status: z.enum(['signed', 'superseded', 'void']),
});

export const PortalAppointment = z.object({
  id: z.uuid(),
  patient: z.object({ id: z.uuid(), name: z.string(), uhid: z.string() }),
  doctorName: z.string().nullable(),
  clinicName: z.string(),
  consultationTypeName: z.string(),
  mode: ConsultationMode,
  /** `YYYY-MM-DD` (IST) */
  date: z.iso.date(),
  startAt: z.iso.datetime(),
  /** IST `HH:MM` */
  startTime: z.string(),
  tokenNumber: z.number().int(),
  status: AppointmentStatus,
  reason: z.string().nullable(),
  /** The patient may still cancel it themselves (booked, and before the cutoff). */
  canCancel: z.boolean(),
  /** The current signed (or voided) prescription of the visit. */
  prescription: PortalPrescriptionRef.nullable(),
});
export type PortalAppointment = z.infer<typeof PortalAppointment>;

export const PortalAppointmentList = z.object({
  /** Upcoming first (soonest first), then past (most recent first). */
  upcoming: z.array(PortalAppointment),
  past: z.array(PortalAppointment),
});
export type PortalAppointmentList = z.infer<typeof PortalAppointmentList>;

export const PortalPrescription = PortalPrescriptionRef.extend({
  patient: z.object({ id: z.uuid(), name: z.string() }),
  doctorName: z.string().nullable(),
  /** Visit date, `YYYY-MM-DD` (IST). */
  date: z.iso.date(),
  signedAt: z.iso.datetime().nullable(),
});
export type PortalPrescription = z.infer<typeof PortalPrescription>;

export const PortalPrescriptionList = z.object({ data: z.array(PortalPrescription) });
export type PortalPrescriptionList = z.infer<typeof PortalPrescriptionList>;
