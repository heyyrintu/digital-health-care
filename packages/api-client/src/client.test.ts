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

  it('uploads a result as the raw file, typed by the file', async () => {
    const order = {
      id: '00000000-0000-4000-8000-000000000001',
      catalogueItemId: null,
      kind: 'mri',
      name: 'MRI',
      region: 'Knee',
      side: 'right',
      views: [],
      notes: null,
      status: 'result_uploaded',
      orderedAt: '2026-10-06T10:00:00.000Z',
      resultUploadedAt: '2026-10-07T10:00:00.000Z',
      reviewedAt: null,
      results: [],
    };
    const fetch = vi.fn(async () => json(201, order));
    const client = createApiClient({ baseUrl: 'https://api.test/v1', fetch });
    const file = new Blob(['%PDF-1.7'], { type: 'application/pdf' });

    await expect(client.uploadTestResult(order.id, file)).resolves.toMatchObject({
      status: 'result_uploaded',
    });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://api.test/v1/test-orders/${order.id}/results`);
    expect(init.method).toBe('POST');
    expect(init.body).toBe(file);
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/pdf');
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

  it('signs a patient in with an SMS code', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        json(200, {
          challengeId: '0b9f3f7e-8f0e-4b8e-9d55-0d3f0c1a2b3c',
          expiresAt: '2026-10-14T10:05:00Z',
        }),
      )
      .mockResolvedValueOnce(
        json(200, { tokenType: 'Bearer', accessToken: 'a', expiresIn: 900, refreshToken: 'r' }),
      );
    const client = createApiClient({ baseUrl: 'https://api.test/v1', fetch });

    const { challengeId } = await client.requestOtp('demo-clinic', '+919800000001');
    const [requestUrl, requestInit] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(requestUrl).toBe('https://api.test/v1/auth/otp/request');
    expect(requestInit.method).toBe('POST');
    expect(JSON.parse(requestInit.body as string)).toEqual({
      organisation: 'demo-clinic',
      phone: '+919800000001',
    });
    await expect(client.verifyOtp(challengeId, '123456')).resolves.toMatchObject({
      accessToken: 'a',
      refreshToken: 'r',
    });
    const [url, init] = fetch.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.test/v1/auth/otp/verify');
    expect(JSON.parse(init.body as string)).toEqual({ challengeId, code: '123456' });
  });
});

describe('platform console calls', () => {
  const expected = {
    registrationNumber: 'TEST-12345',
    council: 'Test Medical Council',
    qualifications: 'MBBS',
    submittedAt: '2026-10-06T04:30:00.000Z',
  };

  it('posts the verification ticket for a profile and parses the result', async () => {
    const fetch = vi.fn(async () =>
      json(200, {
        profileId: '6a0c8a8e-4b1a-4c6f-9d43-2f1f5f6c7a10',
        organisation: {
          id: '0b5b4a36-3c7e-4bb8-9a8e-1e8a7f0e2c11',
          slug: 'clinic-a',
          name: 'Clinic A',
        },
        displayName: 'Dr Synthetic',
        identifier: 'do****@clinic-a.test',
        registrationNumber: 'TEST-12345',
        council: 'Test Medical Council',
        qualifications: 'MBBS',
        specialty: null,
        verification: 'verified',
        submittedAt: '2026-10-06T04:30:00.000Z',
        verifiedAt: '2026-10-06T05:00:00.000Z',
        verifiedBy: 'ops@platform.test (SUP-1)',
        alreadyVerified: false,
      }),
    );
    const client = createApiClient({
      baseUrl: 'https://api.test/v1',
      getAccessToken: () => 'platform-token',
      fetch,
    });
    await expect(
      client.platform.verifyDoctor('6a0c8a8e-4b1a-4c6f-9d43-2f1f5f6c7a10', {
        ticket: 'SUP-1',
        expected,
      }),
    ).resolves.toMatchObject({ verification: 'verified' });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      'https://api.test/v1/platform/doctors/6a0c8a8e-4b1a-4c6f-9d43-2f1f5f6c7a10/verify',
    );
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer platform-token');
    expect(JSON.parse(init.body as string)).toEqual({ ticket: 'SUP-1', expected });
  });

  it('asks for the next page of the verification queue with the cursor', async () => {
    const fetch = vi.fn(async () => json(200, { data: [], hasMore: false, nextCursor: null }));
    const client = createApiClient({ baseUrl: 'https://api.test/v1', fetch });
    await client.platform.doctors('pending', 'abc');
    const [url] = fetch.mock.calls[0] as unknown as [string];
    expect(url).toBe('https://api.test/v1/platform/doctors?status=pending&cursor=abc');
  });

  it('asks for usage over a range', async () => {
    const fetch = vi.fn(async () => json(200, { from: '2026-10-01', to: '2026-10-07', data: [] }));
    const client = createApiClient({
      baseUrl: 'https://api.test/v1',
      getAccessToken: () => 'platform-token',
      fetch,
    });
    await client.platform.usage({ from: '2026-10-01', to: '2026-10-07' });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.test/v1/platform/usage?from=2026-10-01&to=2026-10-07');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer platform-token');
  });

  it('asks for system health', async () => {
    const fetch = vi.fn(async () =>
      json(200, {
        checkedAt: '2026-10-17T06:30:00.000Z',
        api: { version: '1.2.3', uptimeSeconds: 42 },
        database: { status: 'ok', latencyMs: 3, latestMigration: '20261017120000_platform_health' },
        queues: { status: 'not_configured', items: [] },
      }),
    );
    const client = createApiClient({
      baseUrl: 'https://api.test/v1',
      getAccessToken: () => 'platform-token',
      fetch,
    });
    await expect(client.platform.health()).resolves.toMatchObject({
      queues: { status: 'not_configured' },
    });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.test/v1/platform/health');
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer platform-token');
  });

  it('reads a public doctor page without a token, dropping fields it does not know', async () => {
    const page = {
      slug: 'dr-synthetic',
      name: 'Dr. Synthetic',
      qualifications: 'MBBS',
      specialty: null,
      registration: { number: 'TEST-1', council: 'Test Council' },
      about: null,
      languages: ['English'],
      organisation: { slug: 'demo-clinic', name: 'Demo Clinic' },
      clinics: [{ name: 'Main', address: null }],
      consultationTypes: [
        { name: 'In person', mode: 'in_person', durationMin: 15, feePaise: 50000 },
      ],
      updatedAt: '2026-10-18T10:00:00.000Z',
      internalId: 'should not survive parsing',
    };
    const fetch = vi.fn(async () => json(200, page));
    const client = createApiClient({ baseUrl: 'https://api.test/v1', fetch });
    const result = await client.publicDoctor('dr-synthetic');
    expect(result).not.toHaveProperty('internalId');
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.test/v1/public/doctors/dr-synthetic');
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();

    const missing = createApiClient({
      baseUrl: 'https://api.test/v1',
      fetch: vi.fn(async () => json(404, { error: { code: 'NOT_FOUND', message: 'Not found.' } })),
    });
    await expect(missing.publicDoctor('nobody')).rejects.toMatchObject({ status: 404 });
  });

  it('reads a clinic’s public branding without a token', async () => {
    const branding = {
      organisation: { slug: 'demo-clinic', name: 'Demo Clinic' },
      displayName: 'Demo Care',
      accentColour: '#1a6b5c',
      tagline: null,
      logoUrl: null,
      logoKey: 'should not survive parsing',
    };
    const fetch = vi.fn(async () => json(200, branding));
    const client = createApiClient({ baseUrl: 'https://api.test/v1', fetch });
    const result = await client.publicBranding('demo-clinic');
    expect(result).not.toHaveProperty('logoKey');
    expect(result.displayName).toBe('Demo Care');
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.test/v1/public/organisations/demo-clinic/branding');
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it('uploads a logo as the file itself, typed by the file', async () => {
    const fetch = vi.fn(async () =>
      json(400, {
        error: {
          code: 'VALIDATION_FAILED',
          message: 'x',
          fields: { file: 'svg_not_allowed' },
          requestId: 'req_1',
        },
      }),
    );
    const client = createApiClient({ baseUrl: 'https://api.test/v1', fetch });
    const file = new Blob(['<svg/>'], { type: 'image/svg+xml' });
    await expect(client.uploadOrganisationLogo(file)).rejects.toMatchObject({
      status: 400,
      fields: { file: 'svg_not_allowed' },
    });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.test/v1/organisation-branding/logo');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['content-type']).toBe('image/svg+xml');
  });

  it('saves the public page with PATCH', async () => {
    const fetch = vi.fn(async () => json(500, { error: { code: 'INTERNAL', message: 'x' } }));
    const client = createApiClient({ baseUrl: 'https://api.test/v1', fetch });
    await expect(client.saveDoctorPublicProfile({ listed: true })).rejects.toBeInstanceOf(ApiError);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.test/v1/doctor-profile/public');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ listed: true });
  });
  it('makes referral calls with their paths, bodies and query', async () => {
    const fetch = vi.fn(async () => json(500, { error: { code: 'INTERNAL', message: 'x' } }));
    const client = createApiClient({ baseUrl: 'https://api.test/v1', fetch });
    const body = {
      kind: 'external' as const,
      external: { name: 'City Hospital', specialty: null, hospital: null, phone: null },
      reason: 'Opinion',
      urgency: 'routine' as const,
      notes: null,
    };
    await expect(client.createReferral('a 1', body, 'key-12345')).rejects.toBeInstanceOf(ApiError);
    await expect(client.referrals({ box: 'received', status: 'sent' })).rejects.toBeInstanceOf(
      ApiError,
    );
    await expect(client.markReferralSeen('r1')).rejects.toBeInstanceOf(ApiError);
    await expect(client.closeReferral('r1', { note: null })).rejects.toBeInstanceOf(ApiError);
    const calls = fetch.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map(([url, init]) => `${init.method} ${url}`)).toEqual([
      'POST https://api.test/v1/appointments/a%201/referrals',
      'GET https://api.test/v1/referrals?box=received&status=sent',
      'POST https://api.test/v1/referrals/r1/seen',
      'POST https://api.test/v1/referrals/r1/close',
    ]);
    expect(JSON.parse(calls[0]![1].body as string)).toEqual(body);
    expect((calls[0]![1].headers as Record<string, string>)['idempotency-key']).toBe('key-12345');
    expect(JSON.parse(calls[3]![1].body as string)).toEqual({ note: null });
  });
  it('makes referral letter calls with their paths and bodies', async () => {
    const fetch = vi.fn(async () => json(500, { error: { code: 'INTERNAL', message: 'x' } }));
    const client = createApiClient({ baseUrl: 'https://api.test/v1', fetch });
    await expect(client.referralLetterPreview('r1')).rejects.toBeInstanceOf(ApiError);
    await expect(client.referralLetterPreview('r1', 'hi')).rejects.toBeInstanceOf(ApiError);
    await expect(client.signReferralLetter('r1', { pin: '482916' })).rejects.toBeInstanceOf(
      ApiError,
    );
    await expect(client.referralLetter('r 1')).rejects.toBeInstanceOf(ApiError);
    await expect(client.verifyReferralLetter('ABC')).rejects.toBeInstanceOf(ApiError);
    const calls = fetch.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map(([url, init]) => `${init.method} ${url}`)).toEqual([
      'GET https://api.test/v1/referrals/r1/letter/preview',
      'GET https://api.test/v1/referrals/r1/letter/preview?language=hi',
      'POST https://api.test/v1/referrals/r1/letter/sign',
      'GET https://api.test/v1/referrals/r%201/letter',
      'POST https://api.test/v1/verify/referral-letter',
    ]);
    expect((calls[0]![1].headers as Record<string, string>).accept).toBe(
      'application/pdf, application/json',
    );
    expect(JSON.parse(calls[2]![1].body as string)).toEqual({ pin: '482916' });
    expect(JSON.parse(calls[4]![1].body as string)).toEqual({ code: 'ABC' });
  });
});
