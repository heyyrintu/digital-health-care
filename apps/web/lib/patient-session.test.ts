import { ApiError } from '@dhc/api-client';
import { describe, expect, it } from 'vitest';
import {
  acceptsSession,
  idleDelay,
  needsRefresh,
  parseActivity,
  parseTabMessage,
  refreshRetryDelay,
  restoreDecision,
} from './patient-session';

const MIN = 60_000;
const now = Date.parse('2026-10-18T10:00:00Z');
const unreachable = new ApiError(503, 'INTERNAL', 'x', 'web', { api: 'unreachable' });

describe('patient portal session decisions', () => {
  it('accepts only patient sessions', () => {
    expect(acceptsSession({ role: 'patient' })).toBe(true);
    expect(acceptsSession({ role: 'doctor' })).toBe(false);
    expect(acceptsSession({ role: 'clinic_admin' })).toBe(false);
  });

  it('refreshes a token that ran out or is about to, or is missing', () => {
    expect(needsRefresh(null, now)).toBe(true);
    expect(needsRefresh({ expiresAt: now + 10 * MIN }, now)).toBe(false);
    // Within half the refresh lead (30 s), or past expiry after a sleeping tab.
    expect(needsRefresh({ expiresAt: now + 20_000 }, now)).toBe(true);
    expect(needsRefresh({ expiresAt: now - MIN }, now)).toBe(true);
    // Inside the refresh lock, a token with more than the lead left is fresh enough.
    expect(needsRefresh({ expiresAt: now + 2 * MIN }, now, MIN)).toBe(false);
  });

  it('retries a refresh only when the API never received it, and gives up after two', () => {
    expect(refreshRetryDelay(unreachable, 0)).toBe(5_000);
    expect(refreshRetryDelay(unreachable, 1)).toBe(10_000);
    expect(refreshRetryDelay(unreachable, 2)).toBeNull();
    // These may have rotated the refresh token already: sending it again would be reuse.
    expect(refreshRetryDelay(new ApiError(502, 'INTERNAL', 'x', 'web'), 0)).toBeNull();
    expect(refreshRetryDelay(new ApiError(401, 'UNAUTHENTICATED', 'x', 'r'), 0)).toBeNull();
    expect(refreshRetryDelay(new TypeError('fetch failed'), 0)).toBeNull();
  });

  it('reads the stored activity time, ignoring anything else', () => {
    expect(parseActivity(String(now))).toBe(now);
    expect(parseActivity(null)).toBeNull();
    expect(parseActivity('')).toBeNull();
    expect(parseActivity('soon')).toBeNull();
    expect(parseActivity('-5')).toBeNull();
  });

  it('on load, ends a session no tab has used for 15 minutes, unless kept on this device', () => {
    expect(restoreDecision({ lastActivity: now - 5 * MIN, kept: false, now })).toBe('restore');
    expect(restoreDecision({ lastActivity: now - 15 * MIN, kept: false, now })).toBe('end');
    expect(restoreDecision({ lastActivity: now - 60 * MIN, kept: true, now })).toBe('restore');
    // No record (storage blocked): the browser-session cookie is the limit.
    expect(restoreDecision({ lastActivity: null, kept: false, now })).toBe('restore');
  });

  it('on load, finishes a sign-out the server never confirmed, even on a kept device', () => {
    expect(restoreDecision({ lastActivity: now, kept: true, now, signedOut: true })).toBe('end');
    expect(restoreDecision({ lastActivity: null, kept: false, now, signedOut: true })).toBe('end');
  });

  it('counts the idle period from the latest activity in any tab', () => {
    expect(idleDelay({ lastActivity: now - 10 * MIN, kept: false, now })).toBe(5 * MIN);
    expect(idleDelay({ lastActivity: now - 20 * MIN, kept: false, now })).toBe(0);
    expect(idleDelay({ lastActivity: now, kept: true, now })).toBeNull();
  });

  it('reads the other tabs’ messages and nothing else', () => {
    expect(parseTabMessage({ type: 'activity', at: now })).toEqual({ type: 'activity', at: now });
    expect(parseTabMessage({ type: 'signedOut' })).toEqual({ type: 'signedOut' });
    expect(parseTabMessage({ type: 'token', accessToken: 'a', expiresAt: now })).toEqual({
      type: 'token',
      accessToken: 'a',
      expiresAt: now,
    });
    expect(parseTabMessage({ type: 'token', accessToken: 1 })).toBeNull();
    expect(parseTabMessage({ type: 'activity', at: 'now' })).toBeNull();
    expect(parseTabMessage('signedOut')).toBeNull();
    expect(parseTabMessage(null)).toBeNull();
  });
});
