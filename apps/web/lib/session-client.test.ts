import { afterEach, describe, expect, it, vi } from 'vitest';
import { postSession, refreshDelayMs, rolesFromField } from './session-client';

afterEach(() => vi.unstubAllGlobals());

describe('refreshDelayMs', () => {
  it('refreshes a minute before expiry, never sooner than 10 seconds', () => {
    expect(refreshDelayMs(900)).toBe(840_000);
    expect(refreshDelayMs(30)).toBe(10_000);
  });
});

describe('rolesFromField', () => {
  it('keeps only staff roles', () => {
    expect(rolesFromField('doctor,clinic_admin')).toEqual(['doctor', 'clinic_admin']);
    expect(rolesFromField('doctor, patient ,hacker')).toEqual(['doctor']);
    expect(rolesFromField(undefined)).toEqual([]);
  });
});

describe('postSession', () => {
  it('calls the same-origin session route with the bearer token when given', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetch);
    await postSession('logout', undefined, 'access-1');
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/session/logout');
    expect(init.credentials).toBe('same-origin');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer access-1');
  });

  it('turns error responses into ApiError with fields', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: {
                code: 'VALIDATION_FAILED',
                message: 'Choose which role to sign in as.',
                fields: { role: 'doctor,clinic_admin' },
                requestId: 'r',
              },
            }),
            { status: 400 },
          ),
      ),
    );
    await expect(postSession('login', {})).rejects.toMatchObject({
      status: 400,
      fields: { role: 'doctor,clinic_admin' },
    });
  });
});
