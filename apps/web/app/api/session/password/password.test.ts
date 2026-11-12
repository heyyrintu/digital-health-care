import { NextRequest } from 'next/server';
import { afterEach, expect, it, vi } from 'vitest';
import { POST as requestStaff } from './request/route';
import { POST as confirmStaff } from './confirm/route';
import { POST as requestPlatform } from '../../platform-session/password/request/route';
import { POST as confirmPlatform } from '../../platform-session/password/confirm/route';
afterEach(() => vi.unstubAllGlobals());
const req = (
  origin = 'http://localhost:3000',
  body: Record<string, unknown> = { identifier: 'synthetic@example.test' },
) =>
  new NextRequest('http://localhost:3000/api/session/password/request', {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
it.each([requestStaff, confirmStaff, requestPlatform, confirmPlatform])(
  'rejects another origin before forwarding recovery data',
  async (handler) => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect((await handler(req('https://untrusted.test'))).status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  },
);
it.each([
  [requestStaff, '/auth/password/request'],
  [requestPlatform, '/platform/auth/password/request'],
] as const)('forwards to the correct recovery audience', async (handler, path) => {
  const fetch = vi
    .fn()
    .mockResolvedValue(
      Response.json({ challengeId: 'synthetic-id', expiresAt: 'synthetic-date' }, { status: 202 }),
    );
  vi.stubGlobal('fetch', fetch);
  const r = await handler(req());
  expect(r.status).toBe(202);
  expect(fetch.mock.calls[0]![0]).toBe('http://localhost:4000/v1' + path);
  expect(r.headers.get('set-cookie')).toBeNull();
  expect(r.headers.get('cache-control')).toBe('no-store');
});
it.each([
  [confirmStaff, 'dhc_session', '/auth/password/confirm', { organisation: 'synthetic-clinic' }],
  [confirmPlatform, 'dhc_platform_session', '/platform/auth/password/confirm', {}],
] as const)(
  'clears only its browser session after reset',
  async (handler, cookie, path, context) => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetch);
    const payload = {
      ...context,
      challengeId: '11111111-1111-4111-8111-111111111111',
      code: '123456',
      newPassword: 'synthetic replacement passphrase',
    };
    const r = await handler(req('http://localhost:3000', payload));
    expect(fetch.mock.calls[0]![0]).toBe('http://localhost:4000/v1' + path);
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual(payload);
    expect(r.status).toBe(204);
    expect(r.headers.get('set-cookie')).toContain(cookie + '=;');
    expect(r.headers.get('set-cookie')).toMatch(/Max-Age=0/i);
    expect(r.headers.get('set-cookie')).not.toContain(
      (cookie === 'dhc_session' ? 'dhc_platform_session' : 'dhc_session') + '=',
    );
  },
);

it.each([requestStaff, requestPlatform, confirmStaff, confirmPlatform])(
  'handles upstream non-JSON errors without clearing cookies',
  async (handler) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('<html>bad gateway</html>', { status: 502 })),
    );
    const r = await handler(req());
    expect(r.status).toBe(502);
    expect(await r.json()).toEqual({});
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.get('set-cookie')).toBeNull();
  },
);
