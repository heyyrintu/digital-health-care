import { describe, expect, it, vi } from 'vitest';
import { ApiError, createApiClient } from './index';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

describe('createApiClient', () => {
  it('parses a successful response and sends the bearer token', async () => {
    const fetch = vi.fn(async () =>
      json(200, { status: 'ok', service: 'api', version: '0.0.0', time: '2026-10-06T10:00:00Z' }),
    );
    const client = createApiClient({
      baseUrl: 'https://api.test/v1/',
      getAccessToken: () => 'tok',
      fetch,
    });

    await expect(client.getHealth()).resolves.toMatchObject({ status: 'ok' });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.test/v1/health');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok');
  });

  it('sends idempotency keys and query params', async () => {
    const fetch = vi.fn(async () => json(200, { ok: true }));
    const client = createApiClient({ baseUrl: 'https://api.test/v1', fetch });
    const { z } = await import('zod');

    await client.request('POST', '/appointments/a1/check-in', {
      schema: z.object({ ok: z.boolean() }),
      body: {},
      query: { clinic: 'c1', skip: undefined },
      idempotencyKey: 'key-1',
    });

    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.test/v1/appointments/a1/check-in?clinic=c1');
    expect((init.headers as Record<string, string>)['idempotency-key']).toBe('key-1');
  });

  it('turns the standard error shape into an ApiError', async () => {
    const fetch = vi.fn(async () =>
      json(409, {
        error: { code: 'SLOT_TAKEN', message: 'Pick another time.', requestId: 'req_9' },
      }),
    );
    const client = createApiClient({ baseUrl: 'https://api.test/v1', fetch });

    const error = await client.getHealth().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, code: 'SLOT_TAKEN', requestId: 'req_9' });
  });

  it('falls back to a safe generic error for unexpected bodies', async () => {
    const fetch = vi.fn(async () => new Response('Bad gateway', { status: 502 }));
    const client = createApiClient({ baseUrl: 'https://api.test/v1', fetch });

    await expect(client.getHealth()).rejects.toMatchObject({ status: 502, code: 'INTERNAL' });
  });
});

describe('requestFile', () => {
  it('returns the file, and API errors as ApiError', async () => {
    const pdf = new Response(new Uint8Array([37, 80, 68, 70]), {
      status: 200,
      headers: { 'content-type': 'application/pdf' },
    });
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(pdf)
      .mockResolvedValueOnce(
        json(404, { error: { code: 'NOT_FOUND', message: 'Not found.', requestId: 'r1' } }),
      );
    const client = createApiClient({
      baseUrl: 'https://api.test/v1',
      getAccessToken: () => 'tok',
      fetch,
    });
    const blob = await client.requestFile('GET', '/prescriptions/x/pdf');
    expect(new TextDecoder().decode(await blob.arrayBuffer())).toBe('%PDF');
    const [, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok');
    await expect(client.requestFile('GET', '/prescriptions/y/pdf')).rejects.toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
    });
  });
});

describe('invite calls', () => {
  it('posts the token in the body, never in the URL', async () => {
    const fetch = vi.fn(async () =>
      json(200, {
        organisation: { name: 'Demo Clinic', slug: 'demo-clinic' },
        role: 'doctor',
        identifier: 'do****@demo.test',
        account: 'new',
        purpose: 'join',
        expiresAt: '2026-10-09T10:00:00Z',
      }),
    );
    const client = createApiClient({ baseUrl: 'https://api.test/v1', fetch });

    await expect(client.inspectInvite('secret-token')).resolves.toMatchObject({ account: 'new' });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.test/v1/auth/invites/inspect');
    expect(url).not.toContain('secret-token');
    expect(JSON.parse(init.body as string)).toEqual({ token: 'secret-token' });
  });

  it('parses the accept step', async () => {
    const fetch = vi.fn(async () => json(200, { status: 'confirm_required' }));
    const client = createApiClient({ baseUrl: 'https://api.test/v1', fetch });
    await expect(client.acceptInvite('t', 'p')).resolves.toEqual({ status: 'confirm_required' });
  });

  it('handles 204 No Content on logout', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    const client = createApiClient({
      baseUrl: 'https://api.test/v1',
      getAccessToken: () => 'a',
      fetch,
    });
    await expect(client.logout()).resolves.toBeUndefined();
  });
});

describe('staff invite calls', () => {
  it('revokes an invite by id and accepts 204', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    const client = createApiClient({
      baseUrl: 'https://api.test/v1',
      getAccessToken: () => 'a',
      fetch,
    });
    await expect(client.revokeStaffInvite('inv-1')).resolves.toBeUndefined();
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.test/v1/staff/invites/inv-1/revoke');
    expect(init.method).toBe('POST');
  });
});
