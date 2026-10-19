import { z } from 'zod';
import { CursorQuery, page } from './pagination';
import { Language } from './patients';
import { PaperSize, SignatureMethod, SigningPin, VerifyPrescriptionBody } from './prescriptions';

// ---- Referrals (PRD §7.2; API guide §3w) ----------------------------------------------
//
// The visit's doctor refers the patient inside the organisation (to one of its doctors) or
// outside it (a name, and optionally a specialty, hospital and phone), with a reason, an
// urgency and notes. Status sent → seen → closed: opening a received referral marks it
// seen (internal only), and either doctor closes it with an optional note. An internal
// referral that is not closed opens the patient's chart to the receiving doctor under the
// "own patients only" chart model. Doctors only: referrals carry clinical content.
// The referring doctor may sign a referral letter PDF with their signing PIN while the
// referral is open; it never changes afterwards, and closing the referral leaves it
// valid. Not built yet: sending the letter, and attachments.

export const ReferralKind = z.enum(['internal', 'external']);
export type ReferralKind = z.infer<typeof ReferralKind>;

export const ReferralUrgency = z.enum(['routine', 'soon', 'urgent']);
export type ReferralUrgency = z.infer<typeof ReferralUrgency>;

export const ReferralStatus = z.enum(['sent', 'seen', 'closed']);
export type ReferralStatus = z.infer<typeof ReferralStatus>;

/** The limits the database checks too. */
export const REFERRAL_LIMITS = {
  externalName: 120,
  externalSpecialty: 80,
  externalHospital: 160,
  reason: 500,
  notes: 2000,
  closeNote: 500,
} as const;

/** Digits with spaces, brackets and hyphens, optionally after a +: 6 to 20 characters. */
export const REFERRAL_PHONE_PATTERN = /^\+?[0-9][0-9 ()-]{4,18}[0-9]$/;

/** Control characters (line breaks included) are refused in one-line fields. */
const CONTROL = /[\p{Cc}]/u;

/** One line, trimmed and with inner whitespace made one space; empty means none. */
const line = (max: number) =>
  z
    .string()
    .overwrite((s) => s.replace(/\s+/g, ' ').trim())
    .max(max, `Up to ${max} characters.`)
    .refine((s) => !CONTROL.test(s), 'Use one line of plain text.');

/** Optional one-line text: empty, blank or missing is null. */
const optionalLine = (max: number) =>
  line(max)
    .nullish()
    .transform((s) => (s ? s : null));

/**
 * Control characters other than line breaks and tabs (C0, DEL and C1), refused in text
 * that may run over several lines.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_IN_TEXT = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;

/** Text that may run over several lines: trimmed; blank is none when optional. */
const paragraph = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Up to ${max} characters.`)
    .refine((s) => !CONTROL_IN_TEXT.test(s), 'Remove control characters.');

export const ExternalRecipient = z.object({
  name: line(REFERRAL_LIMITS.externalName).pipe(z.string().min(1, 'Enter a name.')),
  specialty: optionalLine(REFERRAL_LIMITS.externalSpecialty),
  hospital: optionalLine(REFERRAL_LIMITS.externalHospital),
  phone: z
    .string()
    .trim()
    .nullish()
    .transform((s) => (s ? s : null))
    .refine((s) => s === null || REFERRAL_PHONE_PATTERN.test(s), 'Enter a phone number.'),
});
export type ExternalRecipient = z.infer<typeof ExternalRecipient>;

const referralFields = {
  reason: paragraph(REFERRAL_LIMITS.reason).pipe(z.string().min(1, 'Enter the reason.')),
  urgency: ReferralUrgency,
  notes: paragraph(REFERRAL_LIMITS.notes)
    .nullish()
    .transform((s) => (s ? s : null)),
};

/** `POST /appointments/{id}/referrals`: from the visit, by its doctor. */
export const CreateReferralBody = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('internal'),
    /** An active doctor of the organisation, not the referring doctor. */
    receivingDoctorUserId: z.uuid(),
    ...referralFields,
  }),
  z.object({
    kind: z.literal('external'),
    external: ExternalRecipient,
    ...referralFields,
  }),
]);
export type CreateReferralBody = z.infer<typeof CreateReferralBody>;

export const CloseReferralBody = z.object({
  note: paragraph(REFERRAL_LIMITS.closeNote)
    .nullish()
    .transform((s) => (s ? s : null)),
});
export type CloseReferralBody = z.infer<typeof CloseReferralBody>;

/** An outside recipient as stored. */
export const ExternalRecipientView = z.object({
  name: z.string(),
  specialty: z.string().nullable(),
  hospital: z.string().nullable(),
  phone: z.string().nullable(),
});
export type ExternalRecipientView = z.infer<typeof ExternalRecipientView>;

const DoctorRef = z.object({ userId: z.uuid(), name: z.string().nullable() });
const PatientRef = z.object({ id: z.uuid(), name: z.string(), uhid: z.string() });

/** A referral in a list: who, to whom, how urgent and where it stands; no clinical text. */
export const ReferralSummary = z.object({
  id: z.uuid(),
  kind: ReferralKind,
  status: ReferralStatus,
  urgency: ReferralUrgency,
  /** The record in use: the kept one when the visit's record was merged. */
  patient: PatientRef,
  referringDoctor: DoctorRef,
  /** Internal referrals only. */
  receivingDoctor: DoctorRef.nullable(),
  /** External referrals only. */
  external: ExternalRecipientView.nullable(),
  appointmentId: z.uuid(),
  visitDate: z.iso.date(),
  sentAt: z.iso.datetime(),
  seenAt: z.iso.datetime().nullable(),
  closedAt: z.iso.datetime().nullable(),
});
export type ReferralSummary = z.infer<typeof ReferralSummary>;

/** The signed referral letter (one per referral, immutable once signed). */
export const ReferralLetter = z.object({
  signedAt: z.iso.datetime(),
  /** The letter's language: the patient's unless the doctor chose the other. */
  language: Language,
  /** The referring doctor's pad size when it was signed. */
  paperSize: PaperSize,
  /** `test_key` signatures are for development and staging only. */
  signatureMethod: SignatureMethod,
  /** The public page its QR opens (`/verify/referral/<code>`). */
  verificationUrl: z.url(),
});
export type ReferralLetter = z.infer<typeof ReferralLetter>;

/** One referral, for the referring or the receiving doctor. */
export const Referral = ReferralSummary.extend({
  reason: z.string(),
  notes: z.string().nullable(),
  closedBy: DoctorRef.nullable(),
  closeNote: z.string().nullable(),
  /** The signed-in doctor's side of it. */
  role: z.enum(['referring', 'receiving']),
  /** True while it is not closed (either doctor may close it). */
  canClose: z.boolean(),
  /** The signed letter, or null before it is signed. */
  letter: ReferralLetter.nullable(),
  /**
   * For the referring doctor while the referral is not closed and has no letter yet: the
   * letter may be previewed and signed (the server still checks the pad and the PIN).
   */
  canSignLetter: z.boolean(),
});
export type Referral = z.infer<typeof Referral>;

// ---- The referral letter (PRD §7.2) --------------------------------------------------

/** `GET /referrals/{id}/letter/preview`: leave the language out for the patient's. */
export const ReferralLetterPreviewQuery = z.object({ language: Language.optional() });
export type ReferralLetterPreviewQuery = z.infer<typeof ReferralLetterPreviewQuery>;

/** `POST /referrals/{id}/letter/sign`: the PIN, and the language (the patient's if left out). */
export const SignReferralLetterBody = z.object({
  pin: SigningPin,
  language: Language.optional(),
});
export type SignReferralLetterBody = z.infer<typeof SignReferralLetterBody>;

/** `POST /verify/referral-letter`: the code from the letter's QR. */
export const VerifyReferralLetterBody = VerifyPrescriptionBody;
export type VerifyReferralLetterBody = z.infer<typeof VerifyReferralLetterBody>;

/**
 * What anyone holding the letter sees after scanning its QR: enough to match the paper
 * (who signed it, when, for whom and to whom), and no clinical text: no reason, notes or
 * diagnoses, and the patient as initials only.
 */
export const ReferralLetterCheck = z.object({
  /** A signed letter stays genuine; closing the referral does not withdraw it. */
  status: z.enum(['genuine']),
  signedAt: z.iso.datetime(),
  signatureMethod: SignatureMethod,
  doctor: z.object({
    name: z.string().nullable(),
    qualifications: z.string().nullable(),
    registrationNumber: z.string().nullable(),
    council: z.string().nullable(),
  }),
  clinicName: z.string(),
  patient: z.object({
    initials: z.string(),
    ageYears: z.number().int().nullable(),
    gender: z.enum(['female', 'male', 'other']).nullable(),
  }),
  /** Who the letter is addressed to, as printed (no phone number). */
  recipient: z.object({
    kind: ReferralKind,
    name: z.string().nullable(),
    specialty: z.string().nullable(),
    hospital: z.string().nullable(),
  }),
  urgency: ReferralUrgency,
  visitDate: z.iso.date(),
});
export type ReferralLetterCheck = z.infer<typeof ReferralLetterCheck>;

export const ReferralList = page(ReferralSummary);
export type ReferralList = z.infer<typeof ReferralList>;

/** The referrals made at one visit, newest first. */
export const VisitReferralList = z.object({ data: z.array(Referral) });
export type VisitReferralList = z.infer<typeof VisitReferralList>;

/** `GET /referrals`: received (to the signed-in doctor) or sent (by them), newest first. */
export const ReferralListQuery = CursorQuery.extend({
  box: z.enum(['received', 'sent']),
  /** Leave out for every status. */
  status: ReferralStatus.optional(),
});
export type ReferralListQuery = z.infer<typeof ReferralListQuery>;

/** The doctor's dashboard figures. */
export const ReferralCounts = z.object({
  /** Received and not yet opened (`sent`). */
  receivedNew: z.number().int().min(0),
  /** Received and not closed. */
  receivedOpen: z.number().int().min(0),
  /** Sent by the doctor and not closed. */
  sentOpen: z.number().int().min(0),
});
export type ReferralCounts = z.infer<typeof ReferralCounts>;
