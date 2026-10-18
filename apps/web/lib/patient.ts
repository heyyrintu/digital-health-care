import {
  ApiError,
  checkPickedFile,
  fileCheckMessage,
  PICK_TYPES,
  uploadErrorMessage,
} from '@dhc/api-client';
import {
  ACCOUNT_CONSENT_KINDS,
  CURRENT_CONSENT_VERSIONS,
  OrganisationSlug,
  type AcceptConsentsBody,
  type AccountConsentKind,
  type BookingOptions,
  type ConsentStatus,
  type PortalAppointment,
  type PortalAppointmentList,
  type PortalPatient,
} from '@dhc/contracts';
import { bookingDays, isAdult, isValidDob } from '@dhc/domain';
import type { MessageKey } from '@dhc/i18n';
import { retryableRefresh } from './platform';

/**
 * Pure helpers behind the patient portal (`/app`, PRD §4), kept out of the components so
 * they can be unit tested. They follow the Patient app's screens, so both behave alike.
 */

type Translate = (key: MessageKey, params?: Record<string, string | number>) => string;

/**
 * What to show for a failed request: the API's own message (it says what to do), or a
 * translated one when the server could not be reached or something unexpected happened.
 */
export function portalErrorMessage(e: unknown, t: Translate): string {
  if (e instanceof TypeError || retryableRefresh(e)) return t('error.network');
  if (e instanceof ApiError) return e.status >= 500 ? t('error.generic') : e.message;
  return t('error.generic');
}

/**
 * Why a portal session could not be restored or kept, for the sign-in page's notice:
 * `offline` a server that could not be reached, null no session to restore (401).
 */
export function sessionEndReason(e: unknown): 'offline' | 'expired' | null {
  if (e instanceof TypeError || retryableRefresh(e)) return 'offline';
  if (e instanceof ApiError && e.status === 401) return null;
  return 'expired';
}

/** A 10-digit Indian mobile, with or without +91, 91 or 0 in front: what the API accepts. */
export function isIndianMobile(value: string): boolean {
  return /^(?:\+91|91|0)?[6-9]\d{9}$/.test(value.replace(/[\s\-()]/g, ''));
}

/** The clinic ID as the API looks it up. */
export const clinicSlug = (value: string) => value.trim().toLowerCase();

/** A clinic ID the API could know: lowercase letters, digits and dashes. */
export const isClinicSlug = (value: string) =>
  OrganisationSlug.safeParse(clinicSlug(value)).success;

// ---- Consents (PRD §4.1) -----------------------------------------------------------

/** The documents still to accept, in the order the screen lists them. */
export const consentsToAccept = (status: ConsentStatus): AccountConsentKind[] =>
  ACCOUNT_CONSENT_KINDS.filter((k) => status.pending.includes(k));

/** A new version of something already accepted, rather than a first visit. */
export const isConsentUpdate = (status: ConsentStatus) =>
  consentsToAccept(status).some((k) => status.consents.some((c) => c.kind === k));

/** Accepts each kind at the version in force, which is the one the screen showed. */
export const acceptBody = (kinds: AccountConsentKind[]): AcceptConsentsBody['accept'] =>
  kinds.map((kind) => ({ kind, version: CURRENT_CONSENT_VERSIONS[kind] }));

/** A consent was withdrawn elsewhere: the person goes back to the consents screen. */
export const consentRequired = (e: unknown) =>
  e instanceof ApiError && e.code === 'CONSENT_REQUIRED';

// ---- Family (PRD §4.1) -------------------------------------------------------------

/** Who can look after a new dependant: adults on this number (the API refuses anyone else). */
export const guardianChoices = (patients: PortalPatient[], today: string) =>
  patients.filter((p) => p.relation === 'account' && (!p.dob || isAdult(p.dob, today)));

export interface PatientDraft {
  name: string;
  dob: string;
  gender: string | null;
  guardianId: string | null;
}

/** What is wrong with a new family member before it is sent, field by field. */
export function patientDraftProblems(
  draft: PatientDraft,
  today: string,
): { name?: MessageKey; dob?: MessageKey; gender?: MessageKey; form?: MessageKey } {
  const dob = draft.dob.trim();
  const problems = {
    ...(draft.name.trim() ? {} : { name: 'patient.profile.nameRequired' as const }),
    ...(isValidDob(dob, today) ? {} : { dob: 'patient.profile.dobInvalid' as const }),
    ...(draft.gender ? {} : { gender: 'portal.genderRequired' as const }),
  };
  if (Object.keys(problems).length > 0) return problems;
  // Children need an adult to look after them; an adult may share the number.
  if (!draft.guardianId && !isAdult(dob, today)) {
    return { form: 'patient.family.childNeedsGuardian' };
  }
  return {};
}

// ---- Appointments (PRD §4.4) -------------------------------------------------------

/** The selected patient's next visit, if any. */
export const nextAppointmentFor = (list: PortalAppointmentList, patientId: string) =>
  list.upcoming.find((a) => a.patient.id === patientId);

/**
 * What an upcoming visit offers: cancel here, a note to call the clinic (booked, but too
 * close to the time), or nothing (already checked in, or done).
 */
export function cancelOption(a: PortalAppointment): 'cancel' | 'call' | null {
  if (a.canCancel) return 'cancel';
  return a.status === 'pending' || a.status === 'confirmed' ? 'call' : null;
}

// ---- Booking (PRD §4.3) ------------------------------------------------------------

/** Whether the clinic offers anything to book online. */
export const canBookOnline = (options: BookingOptions) =>
  options.doctors.length > 0 && options.clinics.length > 0 && options.consultationTypes.length > 0;

/** Every day the clinic takes bookings for, from today. */
export const bookingDates = (today: string, options: BookingOptions) =>
  bookingDays(today, options.horizonDays, options.horizonDays + 1);

/** A fresh Idempotency-Key for one booking attempt (API guide §1). */
export const newAttemptKey = () => `book-${crypto.randomUUID()}`;

/**
 * Whether a failed booking keeps its Idempotency-Key, so that trying again cannot book
 * twice. Kept when the answer was lost (network), when the first attempt is still running
 * or its result is unknown, and on a server error; a clear refusal (slot taken, limit,
 * validation) means nothing was booked, so the next try is a new attempt.
 */
export function keepAttemptKey(e: unknown): boolean {
  if (!(e instanceof ApiError)) return true;
  if (['in_progress', 'unknown'].includes(e.fields.idempotencyKey ?? '')) return true;
  return e.status >= 500;
}

/** Someone took the slot meanwhile: the day's slots need loading again. */
export const slotTaken = (e: unknown) => e instanceof ApiError && e.code === 'SLOT_TAKEN';

// ---- Prescriptions and tests (PRD §4.4, §7.1) --------------------------------------

/** What the file input offers: PDFs and photos, as in the Patient app. */
export const UPLOAD_ACCEPT = PICK_TYPES.join(',');

/**
 * A chosen result file before it is sent: refused with the reason (not a PDF or a photo,
 * empty, or over 25 MB), or the media type to send it as (read from the name when the
 * browser gives none, as some do for HEIC). The server then applies the clinic's limits.
 */
export function checkChosenFile(
  file: Pick<File, 'name' | 'type' | 'size'>,
  t: Translate,
): { text: string } | { mediaType: string } {
  const check = checkPickedFile({ name: file.name, mimeType: file.type, size: file.size });
  if (check.ok) return { mediaType: check.mediaType };
  const m = fileCheckMessage(check.reason);
  return { text: t(m.key, m.params) };
}

/**
 * What to show for an upload the server refused: the app's wording for the file, the
 * 10-result cap and a test reviewed meanwhile, otherwise the usual error message.
 */
export function uploadFailureText(e: unknown, t: Translate): string {
  const known = uploadErrorMessage(e);
  return known ? t(known.key, known.params) : portalErrorMessage(e, t);
}
