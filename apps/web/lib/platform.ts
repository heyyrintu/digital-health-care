import { ApiError } from '@dhc/api-client';
import {
  MAX_USAGE_DAYS,
  SupportTicket,
  type PlatformDoctor,
  type VerifyPlatformDoctorBody,
} from '@dhc/contracts';
import { addDays, istDateKey } from '@dhc/domain';
import type { MessageKey } from '@dhc/i18n';

/**
 * Pure helpers behind the platform console screens (PRD §9.3; API guide §3s), kept out of
 * the components so they can be unit tested.
 */

/** Where a console request failed, for the 401 wording: sign-in steps or a signed-in page. */
export type PlatformStep = 'password' | 'code' | 'page';

/**
 * A localised message for a console refusal, or null to show the API's own message.
 * The 403 is the network allowlist (it answers sign-in too); a 429 is the operator's
 * 15-minute lockout or the per-address rate limit.
 */
export function platformErrorKey(e: unknown, step: PlatformStep): MessageKey | null {
  if (e instanceof TypeError) return 'error.network';
  if (!(e instanceof ApiError)) return 'error.generic';
  if (e.status === 403) return 'platform.error.network';
  if (e.status === 429)
    return lockedOut(e) ? 'platform.error.locked' : 'platform.error.rateLimited';
  if (e.status === 401) {
    if (step === 'password') return 'platform.error.invalidLogin';
    if (step === 'code')
      return mfaExpired(e) ? 'platform.error.mfaExpired' : 'platform.error.invalidCode';
    return 'session.expired';
  }
  if (e.status >= 500) return 'error.generic';
  return null;
}

/*
 * The API gives these two refusals the same status and code as others, so they are told
 * apart by its English wording. `apps/api/src/modules/platform/messages.test.ts` pins that
 * wording (and `platform.test.ts` here pins these patterns to it): rewording it in the API
 * breaks a test, not the sign-in screen.
 */

/** The code step's MFA token ran out (401): the operator starts again from the password. */
export const mfaExpired = (e: unknown) =>
  e instanceof ApiError && e.status === 401 && /start again/i.test(e.message);

/** The operator's 15-minute lockout (429), not the per-address rate limit (also 429). */
export const lockedOut = (e: unknown) =>
  e instanceof ApiError && e.status === 429 && /15 minutes/i.test(e.message);

/**
 * Why a console session could not be restored or kept, for the sign-in page's notice:
 * `network` is the allowlist (403), `offline` a server that could not be reached (as
 * `platformErrorKey` words it), null no session to restore (401).
 */
export function sessionEndReason(e: unknown): 'network' | 'offline' | 'expired' | null {
  if (e instanceof TypeError || unreachable(e)) return 'offline';
  if (!(e instanceof ApiError)) return 'expired';
  if (e.status === 401) return null;
  if (e.status === 403) return 'network';
  return 'expired';
}

/** The web server could not connect to the API at all (session routes' 503). */
const unreachable = (e: unknown) =>
  e instanceof ApiError && e.status === 503 && e.fields.api === 'unreachable';

/**
 * Whether a failed refresh may be tried again: only when the API is known never to have
 * seen it. Any other failure may have rotated the refresh token already, and sending the
 * old one again would count as reuse and end the session.
 */
export const retryableRefresh = unreachable;

/** 409 on verifying: `changed` (reload and check again) or `verified` (someone else did). */
export function verifyConflict(e: unknown): 'changed' | 'verified' | null {
  if (!(e instanceof ApiError) || e.status !== 409) return null;
  const profile = e.fields.profile;
  return profile === 'changed' || profile === 'verified' ? profile : null;
}

/** 409 on onboarding: another organisation already has the slug. */
export const slugTaken = (e: unknown) =>
  e instanceof ApiError && e.status === 409 && e.fields.slug === 'taken';

export const isTicket = (value: string) => SupportTicket.safeParse(value).success;

/**
 * The verify request for a queue row: the ticket, and `expected` exactly as the queue
 * showed it. Null when the row lacks something the operator must have checked.
 */
export function verifyBody(
  doctor: PlatformDoctor,
  ticket: string,
): VerifyPlatformDoctorBody | null {
  const { registrationNumber, council, qualifications, submittedAt } = doctor;
  if (!registrationNumber || !council || !qualifications) return null;
  return {
    ticket: ticket.trim(),
    expected: { registrationNumber, council, qualifications, submittedAt },
  };
}

/** Whether the row has everything the operator must check before verifying. */
export const verifiable = (doctor: PlatformDoctor) => verifyBody(doctor, '') !== null;

/**
 * Adds the next page to the rows already shown, keeping the order. A row already shown is
 * replaced by the page's newer copy rather than repeated.
 */
export function appendPage(shown: PlatformDoctor[], page: PlatformDoctor[]): PlatformDoctor[] {
  const newer = new Map(page.map((d) => [d.profileId, d]));
  const kept = shown.map((d) => newer.get(d.profileId) ?? d);
  const seen = new Set(shown.map((d) => d.profileId));
  return [...kept, ...page.filter((d) => !seen.has(d.profileId))];
}

/** The usage report's default range, as the API's: the 30 IST days ending today. */
export function defaultUsageRange(now: Date): { from: string; to: string } {
  const to = istDateKey(now);
  return { from: addDays(to, -29), to };
}

/** A range the API will accept, or the message to show instead. */
export function usageRangeProblem(from: string, to: string): MessageKey | null {
  if (!from || !to) return 'platform.usage.rangeMissing';
  if (from > to) return 'platform.usage.rangeOrder';
  if (addDays(from, MAX_USAGE_DAYS) <= to) return 'platform.usage.rangeTooLong';
  return null;
}

/** Usage figures that are not built yet (messages, scribe minutes) come back null. */
export const countOrDash = (value: number | null, locale: 'en' | 'hi') =>
  value === null ? '—' : new Intl.NumberFormat(locale === 'hi' ? 'hi-IN' : 'en-IN').format(value);
