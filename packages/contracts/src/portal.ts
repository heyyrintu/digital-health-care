import { z } from 'zod';
import { Gender, Language } from './patients';

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
