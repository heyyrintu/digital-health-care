import { ApiError } from '@dhc/api-client';
import type { PlatformDoctor } from '@dhc/contracts';
import { describe, expect, it } from 'vitest';
import {
  appendPage,
  countOrDash,
  defaultUsageRange,
  isTicket,
  lockedOut,
  mfaExpired,
  platformErrorKey,
  retryableRefresh,
  sessionEndReason,
  slugTaken,
  usageRangeProblem,
  verifiable,
  verifyBody,
  verifyConflict,
} from './platform';

const apiError = (status: number, message = 'x', fields: Record<string, string> = {}) =>
  new ApiError(status, status === 409 ? 'CONFLICT' : 'UNAUTHENTICATED', message, 'r', fields);

// A synthetic doctor (test plan §3 personas are patients; doctors are invented here).
const doctor = (id: string, over: Partial<PlatformDoctor> = {}): PlatformDoctor => ({
  profileId: id,
  organisation: { id: '00000000-0000-4000-8000-000000000001', slug: 'e2e-clinic', name: 'Clinic' },
  displayName: 'Dr. Synthetic',
  identifier: 'do****@e2e-clinic.test',
  registrationNumber: 'TEST-12345',
  council: 'Test Medical Council',
  qualifications: 'MBBS',
  specialty: null,
  verification: 'pending',
  submittedAt: '2026-10-01T04:30:00.000Z',
  verifiedAt: null,
  verifiedBy: null,
  ...over,
});

// The API's own wording, pinned on the API side by `modules/platform/messages.test.ts`.
const LOCKED_MESSAGE = 'Too many attempts. Try again in 15 minutes.';
const MFA_EXPIRED_MESSAGE = 'Your sign-in has expired. Start again.';

describe('API wording the console depends on', () => {
  it('recognises the lockout and the expired code step, and nothing else', () => {
    expect(lockedOut(apiError(429, LOCKED_MESSAGE))).toBe(true);
    expect(lockedOut(apiError(429, 'Request failed.'))).toBe(false);
    expect(mfaExpired(apiError(401, MFA_EXPIRED_MESSAGE))).toBe(true);
    expect(mfaExpired(apiError(401, 'The code is invalid or has expired.'))).toBe(false);
  });
});

describe('session endings', () => {
  const unreachable = new ApiError(503, 'INTERNAL', 'x', 'web', { api: 'unreachable' });

  it('reads a 403 as the network, a 401 as no session, a dropped connection as offline', () => {
    expect(sessionEndReason(apiError(403))).toBe('network');
    expect(sessionEndReason(apiError(401))).toBeNull();
    expect(sessionEndReason(new TypeError('fetch failed'))).toBe('offline');
    expect(sessionEndReason(unreachable)).toBe('offline');
    expect(sessionEndReason(apiError(502))).toBe('expired');
  });

  it('retries a refresh only when the API never saw it', () => {
    expect(retryableRefresh(unreachable)).toBe(true);
    // Sent, or perhaps sent: a retry could replay a rotated token.
    expect(retryableRefresh(new TypeError('fetch failed'))).toBe(false);
    expect(retryableRefresh(apiError(502))).toBe(false);
    expect(retryableRefresh(new ApiError(503, 'INTERNAL', 'x', 'r'))).toBe(false);
    expect(retryableRefresh(apiError(401))).toBe(false);
  });
});

describe('platformErrorKey', () => {
  it('names the network refusal, the lockout and the rate limit, at every step', () => {
    for (const step of ['password', 'code', 'page'] as const) {
      expect(platformErrorKey(apiError(403), step)).toBe('platform.error.network');
      expect(platformErrorKey(apiError(429, LOCKED_MESSAGE), step)).toBe('platform.error.locked');
      expect(platformErrorKey(apiError(429, 'Request failed.'), step)).toBe(
        'platform.error.rateLimited',
      );
    }
  });

  it('words a 401 by step: details, code, expired code step, or session', () => {
    expect(platformErrorKey(apiError(401), 'password')).toBe('platform.error.invalidLogin');
    expect(platformErrorKey(apiError(401, 'The code is invalid'), 'code')).toBe(
      'platform.error.invalidCode',
    );
    expect(platformErrorKey(apiError(401, 'Your sign-in has expired. Start again.'), 'code')).toBe(
      'platform.error.mfaExpired',
    );
    expect(platformErrorKey(apiError(401), 'page')).toBe('session.expired');
  });

  it('falls back to the network message, a generic one, or the API’s own wording', () => {
    expect(platformErrorKey(new TypeError('fetch failed'), 'page')).toBe('error.network');
    expect(platformErrorKey(new Error('boom'), 'page')).toBe('error.generic');
    expect(platformErrorKey(apiError(502), 'page')).toBe('error.generic');
    expect(platformErrorKey(apiError(400), 'page')).toBeNull();
  });
});

describe('conflicts', () => {
  it('tells a changed profile from one verified meanwhile', () => {
    expect(verifyConflict(apiError(409, 'x', { profile: 'changed' }))).toBe('changed');
    expect(verifyConflict(apiError(409, 'x', { profile: 'verified' }))).toBe('verified');
    expect(verifyConflict(apiError(409, 'x', { slug: 'taken' }))).toBeNull();
    expect(verifyConflict(apiError(404))).toBeNull();
  });

  it('recognises a taken slug', () => {
    expect(slugTaken(apiError(409, 'x', { slug: 'taken' }))).toBe(true);
    expect(slugTaken(apiError(409, 'x', { profile: 'changed' }))).toBe(false);
  });
});

describe('verifyBody', () => {
  it('sends the details exactly as the queue showed them', () => {
    expect(verifyBody(doctor('a'), '  SUP-1234 ')).toEqual({
      ticket: 'SUP-1234',
      expected: {
        registrationNumber: 'TEST-12345',
        council: 'Test Medical Council',
        qualifications: 'MBBS',
        submittedAt: '2026-10-01T04:30:00.000Z',
      },
    });
  });

  it('refuses a row missing something the operator must check', () => {
    expect(verifyBody(doctor('a', { council: null }), 'SUP-1')).toBeNull();
    expect(verifyBody(doctor('a', { qualifications: null }), 'SUP-1')).toBeNull();
    expect(verifiable(doctor('a', { council: null }))).toBe(false);
    expect(verifiable(doctor('a'))).toBe(true);
  });

  it('checks ticket IDs as the API does', () => {
    expect(isTicket('SUP-1234')).toBe(true);
    expect(isTicket('ab')).toBe(false);
    expect(isTicket('SUP 1234')).toBe(false);
  });
});

describe('appendPage', () => {
  it('replaces a row already shown with the newer copy', () => {
    const shown = [doctor('a'), doctor('b')];
    const merged = appendPage(shown, [doctor('b', { registrationNumber: 'TEST-2' }), doctor('c')]);
    expect(merged.map((d) => [d.profileId, d.registrationNumber])).toEqual([
      ['a', 'TEST-12345'],
      ['b', 'TEST-2'],
      ['c', 'TEST-12345'],
    ]);
  });

  it('keeps the oldest-first order and drops rows already shown', () => {
    const shown = [doctor('a'), doctor('b')];
    expect(appendPage(shown, [doctor('b'), doctor('c')]).map((d) => d.profileId)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });
});

describe('usage range', () => {
  it('defaults to the 30 IST days ending today', () => {
    // 20:00 UTC on 16 Oct is already 17 Oct in India.
    expect(defaultUsageRange(new Date('2026-10-16T20:00:00Z'))).toEqual({
      from: '2026-09-18',
      to: '2026-10-17',
    });
  });

  it('refuses a reversed, empty or over-long range before asking the API', () => {
    expect(usageRangeProblem('2026-10-02', '2026-10-01')).toBe('platform.usage.rangeOrder');
    expect(usageRangeProblem('', '2026-10-01')).toBe('platform.usage.rangeMissing');
    expect(usageRangeProblem('2025-10-16', '2026-10-17')).toBe('platform.usage.rangeTooLong');
    expect(usageRangeProblem('2025-10-17', '2026-10-17')).toBeNull();
    expect(usageRangeProblem('2026-10-01', '2026-10-01')).toBeNull();
  });

  it('shows a dash for figures not built yet', () => {
    expect(countOrDash(null, 'en')).toBe('—');
    expect(countOrDash(1234, 'en')).toBe('1,234');
    expect(countOrDash(0, 'hi')).toBe('0');
  });
});
