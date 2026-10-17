import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { POST as clinicRefresh } from '../session/refresh/route';
import { POST as login } from './login/route';
import { POST as logout } from './logout/route';
import { POST as mfa } from './mfa/route';
import { POST as refresh } from './refresh/route';

const SITE = 'http://localhost:3000';
const tokens = {
  tokenType: 'Bearer',
  accessToken: 'platform-access-1',
  expiresIn: 900,
  refreshToken: 'platform-refresh-1',
};

function req(
  path: string,
  init: { body?: unknown; origin?: string | null; cookie?: string; auth?: string } = {},
) {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (init.origin !== null) headers.set('origin', init.origin ?? SITE);
  if (init.cookie) headers.set('cookie', init.cookie);
  if (init.auth) headers.set('authorization', init.auth);
  return new NextRequest(`${SITE}${path}`, {
    method: 'POST',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

function mockApi(...responses: { status: number; body?: unknown }[]) {
  const fetch = vi.fn(async () => {
    const next = responses.shift() ?? { status: 500 };
    return next.status === 204
      ? new Response(null, { status: 204 })
      : new Response(JSON.stringify(next.body ?? {}), {
          status: next.status,
          headers: { 'content-type': 'application/json' },
        });
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

const sentTo = (fetch: ReturnType<typeof vi.fn>, i = 0) => {
  const [url, init] = fetch.mock.calls[i] as unknown as [string, RequestInit];
  return {
    url,
    body: init.body ? JSON.parse(init.body as string) : undefined,
    headers: init.headers as Record<string, string>,
  };
};

afterEach(() => vi.unstubAllGlobals());

describe('platform console session', () => {
  it('signs in at the platform endpoints, not the clinic ones', async () => {
    const fetch = mockApi({ status: 200, body: { status: 'mfa_required', mfaToken: 'm' } });
    await login(req('/api/platform-session/login', { body: { email: 'e', password: 'p' } }));
    expect(sentTo(fetch).url).toBe('http://localhost:4000/v1/platform/auth/login');
  });

  it('keeps the refresh token in its own httpOnly cookie on its own path', async () => {
    const fetch = mockApi({ status: 200, body: tokens });
    const res = await mfa(
      req('/api/platform-session/mfa', { body: { mfaToken: 'm', code: '123456' } }),
    );
    expect(sentTo(fetch).url).toBe('http://localhost:4000/v1/platform/auth/mfa/verify');
    expect(await res.json()).toEqual({ accessToken: 'platform-access-1', expiresIn: 900 });
    const cookie = res.headers.get('set-cookie')!;
    expect(cookie).toMatch(/^dhc_platform_session=platform-refresh-1;/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=strict/i);
    expect(cookie).toMatch(/Path=\/api\/platform-session/);
    expect(cookie).toMatch(/Max-Age=28800/);
  });

  it('passes the 429 lockout and the 403 network refusal through without a cookie', async () => {
    for (const [status, code] of [
      [429, 'RATE_LIMITED'],
      [403, 'FORBIDDEN'],
    ] as const) {
      mockApi({ status, body: { error: { code, message: 'x', requestId: 'r' } } });
      const res = await mfa(
        req('/api/platform-session/mfa', { body: { mfaToken: 'm', code: '1' } }),
      );
      expect(res.status).toBe(status);
      expect((await res.json()).error.code).toBe(code);
      expect(res.headers.get('set-cookie')).toBeNull();
    }
  });

  it('rotates the refresh token at the platform refresh endpoint', async () => {
    const fetch = mockApi({
      status: 200,
      body: { ...tokens, accessToken: 'platform-access-2', refreshToken: 'platform-refresh-2' },
    });
    const res = await refresh(
      req('/api/platform-session/refresh', { cookie: 'dhc_platform_session=platform-refresh-1' }),
    );
    expect(sentTo(fetch)).toMatchObject({
      url: 'http://localhost:4000/v1/platform/auth/refresh',
      body: { refreshToken: 'platform-refresh-1' },
    });
    expect(res.headers.get('set-cookie')).toMatch(/dhc_platform_session=platform-refresh-2/);
  });

  it('clears its cookie when the API refuses the refresh', async () => {
    mockApi({
      status: 401,
      body: {
        error: { code: 'UNAUTHENTICATED', message: 'Please sign in again.', requestId: 'r' },
      },
    });
    const res = await refresh(
      req('/api/platform-session/refresh', { cookie: 'dhc_platform_session=stale' }),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toMatch(/dhc_platform_session=;.*Max-Age=0/i);
  });

  it('never uses a clinic session, and the clinic never uses a console session', async () => {
    const fetch = mockApi();
    const platform = await refresh(
      req('/api/platform-session/refresh', { cookie: 'dhc_session=clinic-refresh' }),
    );
    expect(platform.status).toBe(401);
    const clinic = await clinicRefresh(
      req('/api/session/refresh', { cookie: 'dhc_platform_session=platform-refresh-1' }),
    );
    expect(clinic.status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('ends the API session on logout, refreshing first when the page has no token', async () => {
    const fetch = mockApi({ status: 200, body: tokens }, { status: 204 });
    const res = await logout(
      req('/api/platform-session/logout', { cookie: 'dhc_platform_session=platform-refresh-1' }),
    );
    expect(sentTo(fetch, 0).url).toBe('http://localhost:4000/v1/platform/auth/refresh');
    expect(sentTo(fetch, 1).url).toBe('http://localhost:4000/v1/platform/auth/logout');
    expect(sentTo(fetch, 1).headers.authorization).toBe('Bearer platform-access-1');
    expect(res.status).toBe(204);
    expect(res.headers.get('set-cookie')).toMatch(/dhc_platform_session=;.*Max-Age=0/i);
  });

  it.each([
    ['another site', 'https://evil.example'],
    ['no Origin header', null],
  ])('rejects requests from %s without calling the API', async (_label, origin) => {
    const fetch = mockApi({ status: 200, body: tokens });
    const res = await login(req('/api/platform-session/login', { origin, body: {} }));
    expect(res.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });
});
