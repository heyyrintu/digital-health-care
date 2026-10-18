import type { MeResponse } from '@dhc/contracts';
import { retryableRefresh } from './platform';
import { IDLE_TIMEOUT_MS, REFRESH_LEAD_MS } from './session-client';

/**
 * The patient portal session's decisions (`app/app/session-provider.tsx`), kept pure so they
 * can be unit tested: which sessions the portal accepts, when to refresh, when to retry a
 * refresh, and when an idle session ends, across every tab of the browser.
 */

/** The portal is for patients; a session with any other role is not used here. */
export const acceptsSession = (me: Pick<MeResponse, 'role'>) => me.role === 'patient';

/**
 * Whether the access token should be renewed before it is used: it has run out or is about
 * to (a tab that slept past its scheduled refresh), or there is none to use.
 */
export function needsRefresh(
  token: { expiresAt: number } | null,
  now: number,
  leadMs = REFRESH_LEAD_MS / 2,
): boolean {
  return !token || now >= token.expiresAt - leadMs;
}

/**
 * How long to wait before trying a failed refresh again, or null to give up. Only a refresh
 * the API never received is retried: any other may have rotated the refresh token already,
 * and sending the old one again would count as reuse and end the session.
 */
export function refreshRetryDelay(
  e: unknown,
  attempt: number,
  { retries = 2, baseMs = 5_000 }: { retries?: number; baseMs?: number } = {},
): number | null {
  if (attempt >= retries || !retryableRefresh(e)) return null;
  return baseMs * (attempt + 1);
}

/** The localStorage keys the portal keeps: conveniences, never a credential. */
export const ACTIVITY_KEY = 'dhc.patientActivity';
export const KEEP_KEY = 'dhc.patientKeep';
/** Set while a sign-out has not been confirmed by the server: the cookie may still be live. */
export const SIGNED_OUT_KEY = 'dhc.patientSignedOut';

/** A stored activity time (ms since epoch), or null when there is none or it is not one. */
export function parseActivity(raw: string | null | undefined): number | null {
  if (!raw || !/^\d{1,16}$/.test(raw)) return null;
  return Number(raw);
}

/**
 * On load, whether to restore the session from its cookie, or end it as idle. A patient who
 * chose to stay signed in on this device is restored; otherwise the session ends when no
 * tab has seen activity for the idle period (a tab closed and reopened later, or a reload
 * after the computer was left). With no record (storage blocked, or never written) the
 * browser-session cookie, gone when the browser closes, is the only limit.
 */
export function restoreDecision({
  lastActivity,
  kept,
  now,
  signedOut = false,
  idleMs = IDLE_TIMEOUT_MS,
}: {
  lastActivity: number | null;
  kept: boolean;
  now: number;
  /** A sign-out the server never confirmed: finish it, never restore. */
  signedOut?: boolean;
  idleMs?: number;
}): 'restore' | 'end' {
  if (signedOut) return 'end';
  if (kept || lastActivity === null) return 'restore';
  return now - lastActivity >= idleMs ? 'end' : 'restore';
}

/**
 * How long until the session ends as idle, given the latest activity in any tab: 0 when it
 * is due now, null when it never ends as idle (kept on this device).
 */
export function idleDelay({
  lastActivity,
  kept,
  now,
  idleMs = IDLE_TIMEOUT_MS,
}: {
  lastActivity: number;
  kept: boolean;
  now: number;
  idleMs?: number;
}): number | null {
  if (kept) return null;
  return Math.max(0, lastActivity + idleMs - now);
}

/** Record activity at most this often (localStorage writes and messages to other tabs). */
export const ACTIVITY_THROTTLE_MS = 15_000;

/**
 * What the portal's tabs tell each other on their BroadcastChannel: activity (so an idle
 * background tab does not end a session in use), a fresh access token (so a tab waiting for
 * the refresh lock need not refresh again), and sign-out (so every tab signs out).
 */
export type TabMessage =
  | { type: 'activity'; at: number }
  | { type: 'token'; accessToken: string; expiresAt: number }
  | { type: 'signedOut' };

export const TAB_CHANNEL = 'dhc-patient-session';
export const REFRESH_LOCK = 'dhc-patient-refresh';

/** A message from another tab, or null for anything else on the channel. */
export function parseTabMessage(data: unknown): TabMessage | null {
  const m = data as Partial<Record<string, unknown>> | null;
  if (!m || typeof m !== 'object') return null;
  if (m.type === 'activity' && typeof m.at === 'number') return { type: 'activity', at: m.at };
  if (m.type === 'signedOut') return { type: 'signedOut' };
  if (m.type === 'token' && typeof m.accessToken === 'string' && typeof m.expiresAt === 'number') {
    return { type: 'token', accessToken: m.accessToken, expiresAt: m.expiresAt };
  }
  return null;
}
