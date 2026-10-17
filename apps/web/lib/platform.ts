import { ApiError } from '@dhc/api-client';
import {
  MAX_USAGE_DAYS,
  SupportTicket,
  type PlatformDoctor,
  type PlatformHealth,
  type QueueName,
  type VerifyPlatformDoctorBody,
} from '@dhc/contracts';
import { CLINIC_TIME_ZONE, addDays, istDateKey } from '@dhc/domain';
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

/**
 * The system health page's message for a failed check. A 5xx (502 and 503 from a proxy
 * included) usually means the database is fully down: the API's sign-in check reads it
 * before the health check can run, so the page says so rather than "something went wrong".
 */
export function healthErrorKey(e: unknown): MessageKey | null {
  if (e instanceof ApiError && e.status >= 500 && !unreachable(e)) {
    return 'platform.health.unavailable';
  }
  return platformErrorKey(e, 'page');
}

/**
 * `fn`, except that a call while an earlier one is still in flight gets that call's promise
 * instead of starting another, when it is for the same `key` (the first argument, e.g. the
 * signed-in operator: another session never shares a request it did not make). Each key has
 * its own slot; once a call settles, the next call for that key starts afresh.
 */
export function shareInFlight<K, A extends unknown[], T>(
  fn: (key: K, ...args: A) => Promise<T>,
): (key: K, ...args: A) => Promise<T> {
  const inFlight = new Map<K, Promise<T>>();
  return (key, ...args) => {
    const pending = inFlight.get(key);
    if (pending) return pending;
    const promise = fn(key, ...args).finally(() => {
      if (inFlight.get(key) === promise) inFlight.delete(key);
    });
    inFlight.set(key, promise);
    return promise;
  };
}

/** Any status on the system health page: the database's, the queues' or the API's (`ok`). */
export type HealthStatus = PlatformHealth['queues']['status'];

const HEALTH_STATUS_KEYS: Record<HealthStatus, MessageKey> = {
  ok: 'platform.health.status.ok',
  down: 'platform.health.status.down',
  not_configured: 'platform.health.status.not_configured',
};

export const healthStatusKey = (status: HealthStatus): MessageKey => HEALTH_STATUS_KEYS[status];

/** The colours for a status: green for OK, red for down, plain for not configured. */
export function healthTone(status: HealthStatus): 'ok' | 'danger' | 'neutral' {
  if (status === 'ok') return 'ok';
  if (status === 'down') return 'danger';
  return 'neutral';
}

/** What the queues card says under its status. */
export function queuesNoteKey(status: HealthStatus): MessageKey {
  if (status === 'ok') return 'platform.health.queuesOk';
  if (status === 'down') return 'platform.health.queuesDown';
  return 'platform.health.queuesNotConfigured';
}

const QUEUE_LABEL_KEYS: Record<QueueName, MessageKey> = {
  system: 'platform.health.queue.system',
  messaging: 'platform.health.queue.messaging',
  documents: 'platform.health.queue.documents',
  webhooks: 'platform.health.queue.webhooks',
  abdm: 'platform.health.queue.abdm',
  imports: 'platform.health.queue.imports',
  reconciliation: 'platform.health.queue.reconciliation',
};

export const queueLabelKey = (name: QueueName): MessageKey => QUEUE_LABEL_KEYS[name];

/** The queues holding jobs that failed after every retry, in the report's order. */
export const queuesWithFailures = (health: PlatformHealth): QueueName[] =>
  health.queues.items.filter((q) => q.failed > 0).map((q) => q.name);

/** How long the API server has been running, as a message: days and hours, or hours and minutes. */
export function uptimeMessage(seconds: number): {
  key: MessageKey;
  params: Record<string, number>;
} {
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return { key: 'platform.health.uptimeDays', params: { days, hours: hours % 24 } };
  if (hours > 0) {
    return { key: 'platform.health.uptimeHours', params: { hours, minutes: minutes % 60 } };
  }
  return { key: 'platform.health.uptimeMinutes', params: { minutes } };
}

/** When health was checked, in IST to the second: a refresh a moment later reads differently. */
export const formatCheckedAt = (iso: string, locale: 'en' | 'hi') =>
  new Intl.DateTimeFormat(locale === 'hi' ? 'hi-IN' : 'en-IN', {
    timeZone: CLINIC_TIME_ZONE,
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(iso));
