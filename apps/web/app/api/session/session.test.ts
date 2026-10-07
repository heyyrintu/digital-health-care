import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { POST as invite } from './invite/route';
import { POST as login } from './login/route';
import { POST as logout } from './logout/route';
import { POST as mfa } from './mfa/route';
import { POST as refresh } from './refresh/route';

const SITE = 'http://localhost:3000';
const tokens = {
  tokenType: 'Bearer',
  accessToken: 'access-1',
  expiresIn: 900,
  refreshToken: 'refresh-1',
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

describe('session cookie', () => {
  it('keeps the refresh token in an httpOnly, SameSite=Strict cookie and never in the body', async () => {
    mockApi({ status: 200, body: tokens });
    const res = await mfa(req('/api/session/mfa', { body: { mfaToken: 'm', code: '123456' } }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accessToken: 'access-1', expiresIn: 900 });
    const cookie = res.headers.get('set-cookie')!;
    expect(cookie).toMatch(/^dhc_session=refresh-1;/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=strict/i);
    expect(cookie).toMatch(/Path=\/api\/session/);
  });

  it('starts a session when an invite is completed', async () => {
    const fetch = mockApi({ status: 200, body: tokens });
    const res = await invite(req('/api/session/invite', { body: { token: 't', code: '123456' } }));
    expect(sentTo(fetch).url).toBe('http://localhost:4000/v1/auth/invites/complete');
    expect(res.headers.get('set-cookie')).toMatch(/dhc_session=refresh-1/);
  });

  it('passes API errors through without setting a cookie', async () => {
    mockApi({
      status: 401,
      body: {
        error: {
          code: 'UNAUTHENTICATED',
          message: 'The code is invalid or has expired.',
          requestId: 'r',
        },
      },
    });
    const res = await mfa(req('/api/session/mfa', { body: { mfaToken: 'm', code: '000000' } }));
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('UNAUTHENTICATED');
    expect(res.headers.get('set-cookie')).toBeNull();
  });
});

describe('refresh', () => {
  it('sends the cookie’s refresh token and rotates the cookie', async () => {
    const fetch = mockApi({
      status: 200,
      body: { ...tokens, accessToken: 'access-2', refreshToken: 'refresh-2' },
    });
    const res = await refresh(req('/api/session/refresh', { cookie: 'dhc_session=refresh-1' }));
    expect(sentTo(fetch).body).toEqual({ refreshToken: 'refresh-1' });
    expect(await res.json()).toEqual({ accessToken: 'access-2', expiresIn: 900 });
    expect(res.headers.get('set-cookie')).toMatch(/dhc_session=refresh-2/);
  });

  it('returns 401 without calling the API when there is no session', async () => {
    const fetch = mockApi();
    const res = await refresh(req('/api/session/refresh'));
    expect(res.status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('clears the cookie when the API refuses the refresh', async () => {
    mockApi({
      status: 401,
      body: {
        error: { code: 'UNAUTHENTICATED', message: 'Please sign in again.', requestId: 'r' },
      },
    });
    const res = await refresh(req('/api/session/refresh', { cookie: 'dhc_session=stale' }));
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toMatch(/dhc_session=;.*Max-Age=0/i);
  });
});

describe('logout', () => {
  it('ends the API session with the access token and clears the cookie', async () => {
    const fetch = mockApi({ status: 204 });
    const res = await logout(
      req('/api/session/logout', { cookie: 'dhc_session=refresh-1', auth: 'Bearer access-1' }),
    );
    expect(res.status).toBe(204);
    expect(sentTo(fetch).url).toBe('http://localhost:4000/v1/auth/logout');
    expect(sentTo(fetch).headers.authorization).toBe('Bearer access-1');
    expect(res.headers.get('set-cookie')).toMatch(/Max-Age=0/i);
  });

  it('refreshes first when the page has no access token', async () => {
    const fetch = mockApi({ status: 200, body: tokens }, { status: 204 });
    await logout(req('/api/session/logout', { cookie: 'dhc_session=refresh-1' }));
    expect(sentTo(fetch, 0).url).toMatch(/\/auth\/refresh$/);
    expect(sentTo(fetch, 1).headers.authorization).toBe('Bearer access-1');
  });

  it('still clears the cookie when the API is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    const res = await logout(
      req('/api/session/logout', { cookie: 'dhc_session=refresh-1', auth: 'Bearer a' }),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('set-cookie')).toMatch(/Max-Age=0/i);
  });
});

describe('cross-site protection', () => {
  it.each([
    ['another site', 'https://evil.example'],
    ['no Origin header', null],
  ])('rejects requests from %s without calling the API', async (_label, origin) => {
    const fetch = mockApi({ status: 200, body: tokens });
    const res = await login(req('/api/session/login', { origin, body: {} }));
    expect(res.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports an unreachable API as a 502 in the standard error shape', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    const res = await login(req('/api/session/login', { body: {} }));
    expect(res.status).toBe(502);
    expect((await res.json()).error.code).toBe('INTERNAL');
  });
});
