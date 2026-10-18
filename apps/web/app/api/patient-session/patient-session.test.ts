import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { POST as platformRefresh } from '../platform-session/refresh/route';
import { POST as staffRefresh } from '../session/refresh/route';
import { POST as logout } from './logout/route';
import { POST as requestCode } from './otp/request/route';
import { POST as verifyCode } from './otp/verify/route';
import { POST as refresh } from './refresh/route';

const SITE = 'http://localhost:3000';
const API = 'http://localhost:4000/v1';
const tokens = {
  tokenType: 'Bearer',
  accessToken: 'patient-access-1',
  expiresIn: 900,
  refreshToken: 'patient-refresh-1',
};

function req(
  path: string,
  init: {
    body?: unknown;
    origin?: string | null;
    cookie?: string;
    auth?: string;
    forwardedFor?: string;
  } = {},
) {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (init.forwardedFor) headers.set('x-forwarded-for', init.forwardedFor);
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

/** One Set-Cookie header by cookie name (a response may set several). */
const cookieNamed = (res: Response, name: string) =>
  res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));

const challenge = { challengeId: '0b8f3a52-3c1e-4f3a-9a57-5f6c2d1e0a9b', expiresAt: 'x' };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('patient portal session', () => {
  it('asks the API for a code and sets no cookie', async () => {
    const fetch = mockApi({ status: 200, body: challenge });
    const body = { organisation: 'demo-clinic', phone: '98765 43210' };
    const res = await requestCode(req('/api/patient-session/otp/request', { body }));
    expect(sentTo(fetch)).toMatchObject({ url: `${API}/auth/otp/request`, body });
    expect(await res.json()).toEqual(challenge);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('keeps the refresh token in its own httpOnly cookie, until the browser closes by default', async () => {
    const fetch = mockApi({ status: 200, body: tokens });
    const res = await verifyCode(
      req('/api/patient-session/otp/verify', {
        body: { challengeId: challenge.challengeId, code: '123456', keep: false },
      }),
    );
    expect(sentTo(fetch)).toMatchObject({ url: `${API}/auth/otp/verify` });
    // The choice is the web app's own; the API never sees it.
    expect(sentTo(fetch).body).toEqual({ challengeId: challenge.challengeId, code: '123456' });
    // Only the access token reaches the page.
    expect(await res.json()).toEqual({ accessToken: 'patient-access-1', expiresIn: 900 });
    const session = cookieNamed(res, 'dhc_patient_session')!;
    expect(session).toMatch(/^dhc_patient_session=patient-refresh-1;/);
    expect(session).toMatch(/HttpOnly/i);
    expect(session).toMatch(/SameSite=strict/i);
    expect(session).toMatch(/Path=\/api\/patient-session/);
    expect(session).not.toMatch(/Max-Age|Expires/i);
    expect(cookieNamed(res, 'dhc_patient_keep')).toMatch(/Max-Age=0/);
  });

  it('keeps the session for 30 days only when the patient asks to stay signed in', async () => {
    mockApi({ status: 200, body: tokens });
    const res = await verifyCode(
      req('/api/patient-session/otp/verify', {
        body: { challengeId: challenge.challengeId, code: '123456', keep: true },
      }),
    );
    expect(cookieNamed(res, 'dhc_patient_session')).toMatch(/Max-Age=2592000/);
    const keep = cookieNamed(res, 'dhc_patient_keep')!;
    expect(keep).toMatch(/^dhc_patient_keep=1;/);
    expect(keep).toMatch(/HttpOnly/i);
    expect(keep).toMatch(/Path=\/api\/patient-session/);
    expect(keep).toMatch(/Max-Age=2592000/);
  });

  it('keeps the chosen lifetime when it refreshes', async () => {
    mockApi({ status: 200, body: tokens }, { status: 200, body: tokens });
    const kept = await refresh(
      req('/api/patient-session/refresh', {
        cookie: 'dhc_patient_session=patient-refresh-0; dhc_patient_keep=1',
      }),
    );
    expect(cookieNamed(kept, 'dhc_patient_session')).toMatch(/Max-Age=2592000/);
    const browserOnly = await refresh(
      req('/api/patient-session/refresh', { cookie: 'dhc_patient_session=patient-refresh-0' }),
    );
    expect(cookieNamed(browserOnly, 'dhc_patient_session')).not.toMatch(/Max-Age|Expires/i);
  });

  it('passes a wrong code (401) and the rate limit (429) through without a cookie', async () => {
    for (const [status, code] of [
      [401, 'UNAUTHENTICATED'],
      [429, 'RATE_LIMITED'],
    ] as const) {
      mockApi({ status, body: { error: { code, message: 'x', requestId: 'r' } } });
      const res = await verifyCode(
        req('/api/patient-session/otp/verify', { body: { challengeId: 'c', code: '1' } }),
      );
      expect(res.status).toBe(status);
      expect((await res.json()).error.code).toBe(code);
      expect(res.headers.get('set-cookie')).toBeNull();
    }
  });

  it('rotates the refresh token with the patient cookie only', async () => {
    const fetch = mockApi({
      status: 200,
      body: { ...tokens, accessToken: 'patient-access-2', refreshToken: 'patient-refresh-2' },
    });
    const res = await refresh(
      req('/api/patient-session/refresh', {
        cookie: 'dhc_session=staff-refresh; dhc_patient_session=patient-refresh-1',
      }),
    );
    expect(sentTo(fetch)).toMatchObject({
      url: `${API}/auth/refresh`,
      body: { refreshToken: 'patient-refresh-1' },
    });
    expect(cookieNamed(res, 'dhc_patient_session')).toMatch(
      /dhc_patient_session=patient-refresh-2/,
    );
  });

  it('clears its cookie when the API refuses the refresh', async () => {
    mockApi({
      status: 401,
      body: {
        error: { code: 'UNAUTHENTICATED', message: 'Please sign in again.', requestId: 'r' },
      },
    });
    const res = await refresh(
      req('/api/patient-session/refresh', { cookie: 'dhc_patient_session=stale' }),
    );
    expect(res.status).toBe(401);
    expect(cookieNamed(res, 'dhc_patient_session')).toMatch(/dhc_patient_session=;.*Max-Age=0/i);
    expect(cookieNamed(res, 'dhc_patient_keep')).toMatch(/Max-Age=0/i);
  });

  it('never uses a staff or console session, and they never use a patient one', async () => {
    const fetch = mockApi();
    const patient = await refresh(
      req('/api/patient-session/refresh', {
        cookie: 'dhc_session=staff-refresh; dhc_platform_session=platform-refresh',
      }),
    );
    expect(patient.status).toBe(401);
    const staff = await staffRefresh(
      req('/api/session/refresh', { cookie: 'dhc_patient_session=patient-refresh-1' }),
    );
    expect(staff.status).toBe(401);
    const platform = await platformRefresh(
      req('/api/platform-session/refresh', { cookie: 'dhc_patient_session=patient-refresh-1' }),
    );
    expect(platform.status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('ends the API session on logout, refreshing first when the page has no token', async () => {
    const fetch = mockApi({ status: 200, body: tokens }, { status: 204 });
    const res = await logout(
      req('/api/patient-session/logout', { cookie: 'dhc_patient_session=patient-refresh-1' }),
    );
    expect(sentTo(fetch, 0).url).toBe(`${API}/auth/refresh`);
    expect(sentTo(fetch, 1)).toMatchObject({
      url: `${API}/auth/logout`,
      headers: { authorization: 'Bearer patient-access-1' },
    });
    expect(res.status).toBe(204);
    expect(cookieNamed(res, 'dhc_patient_session')).toMatch(/dhc_patient_session=;.*Max-Age=0/i);
    expect(cookieNamed(res, 'dhc_patient_keep')).toMatch(/Max-Age=0/i);
  });

  it('logs out with the page token when it still works, and clears the cookie', async () => {
    const fetch = mockApi({ status: 204 });
    const res = await logout(
      req('/api/patient-session/logout', {
        cookie: 'dhc_patient_session=patient-refresh-1',
        auth: 'Bearer patient-access-1',
      }),
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sentTo(fetch).url).toBe(`${API}/auth/logout`);
    expect(cookieNamed(res, 'dhc_patient_session')).toMatch(/dhc_patient_session=;.*Max-Age=0/i);
    expect(cookieNamed(res, 'dhc_patient_keep')).toMatch(/Max-Age=0/i);
  });

  it('clears the cookie on logout even when the API cannot be reached', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
      }),
    );
    const res = await logout(
      req('/api/patient-session/logout', {
        cookie: 'dhc_patient_session=patient-refresh-1',
        auth: 'Bearer patient-access-1',
      }),
    );
    expect(res.status).toBe(204);
    expect(cookieNamed(res, 'dhc_patient_session')).toMatch(/dhc_patient_session=;.*Max-Age=0/i);
    expect(cookieNamed(res, 'dhc_patient_keep')).toMatch(/Max-Age=0/i);
  });

  it('tells an API it never reached (503, retryable) from a failed request (502)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
      }),
    );
    const cookie = 'dhc_patient_session=patient-refresh-1';
    const down = await refresh(req('/api/patient-session/refresh', { cookie }));
    expect(down.status).toBe(503);
    expect((await down.json()).error.fields).toEqual({ api: 'unreachable' });
    expect(down.headers.get('set-cookie')).toBeNull();

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
      }),
    );
    const reset = await refresh(req('/api/patient-session/refresh', { cookie }));
    expect(reset.status).toBe(502);
  });

  it('with FORWARD_CLIENT_IP, passes on only the load balancer’s entry', async () => {
    vi.stubEnv('FORWARD_CLIENT_IP', 'true');
    const fetch = mockApi({ status: 200, body: challenge });
    await requestCode(
      req('/api/patient-session/otp/request', {
        body: {},
        forwardedFor: '10.0.0.5, 203.0.113.7',
      }),
    );
    expect(sentTo(fetch).headers['x-forwarded-for']).toBe('203.0.113.7');
  });

  it.each([
    ['another site', 'https://evil.example'],
    ['no Origin header', null],
  ])('rejects requests from %s without calling the API', async (_label, origin) => {
    const fetch = mockApi({ status: 200, body: tokens });
    for (const res of [
      await requestCode(req('/api/patient-session/otp/request', { origin, body: {} })),
      await verifyCode(req('/api/patient-session/otp/verify', { origin, body: {} })),
      await refresh(
        req('/api/patient-session/refresh', { origin, cookie: 'dhc_patient_session=x' }),
      ),
      await logout(req('/api/patient-session/logout', { origin, cookie: 'dhc_patient_session=x' })),
    ]) {
      expect(res.status).toBe(403);
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});
