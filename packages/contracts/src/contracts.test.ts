import { describe, expect, it } from 'vitest';
import {
  CursorQuery,
  DEFAULT_PAGE_LIMIT,
  ErrorResponse,
  HealthResponse,
  LoginResponse,
  NewPassword,
  PlatformHealth,
  QUEUES,
  QUEUE_NAMES,
  buildOpenApiDocument,
  checkUpload,
  page,
} from './index';
import { z } from 'zod';

describe('ErrorResponse', () => {
  it('accepts the documented error shape', () => {
    const parsed = ErrorResponse.parse({
      error: {
        code: 'SLOT_TAKEN',
        message: 'This slot was just booked. Pick another time.',
        fields: { slotStart: 'taken' },
        requestId: 'req_123',
      },
    });
    expect(parsed.error.code).toBe('SLOT_TAKEN');
  });

  it('rejects unknown error codes', () => {
    expect(() =>
      ErrorResponse.parse({ error: { code: 'NOPE', message: 'x', requestId: 'req_1' } }),
    ).toThrow();
  });
});

describe('CursorQuery', () => {
  it('defaults the limit and coerces strings from the query string', () => {
    expect(CursorQuery.parse({}).limit).toBe(DEFAULT_PAGE_LIMIT);
    expect(CursorQuery.parse({ limit: '10', cursor: 'abc' })).toEqual({ limit: 10, cursor: 'abc' });
  });

  it('rejects limits outside 1..100', () => {
    expect(() => CursorQuery.parse({ limit: '0' })).toThrow();
    expect(() => CursorQuery.parse({ limit: '101' })).toThrow();
  });
});

describe('page', () => {
  it('wraps items with a nullable cursor', () => {
    const Page = page(z.object({ id: z.string() }));
    expect(Page.parse({ data: [{ id: 'a' }], nextCursor: null }).data).toHaveLength(1);
  });
});

describe('HealthResponse', () => {
  it('requires an ISO timestamp', () => {
    expect(() =>
      HealthResponse.parse({ status: 'ok', service: 'api', version: '0.0.0', time: 'today' }),
    ).toThrow();
  });
});

describe('buildOpenApiDocument', () => {
  const doc = buildOpenApiDocument({ version: '0.0.0' });

  it('produces an OpenAPI 3.1 document with the error component', () => {
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.components.schemas.ErrorResponse).toMatchObject({ type: 'object' });
  });

  it('marks only sign-in, health, waiting-room screen and QR check endpoints as public', () => {
    const publicOps = Object.entries(doc.paths).flatMap(([path, ops]) =>
      Object.entries(ops)
        .filter(([, op]) => (op as { security?: unknown[] }).security?.length === 0)
        .map(([method]) => `${method.toUpperCase()} ${path}`),
    );
    expect(publicOps.sort()).toEqual([
      'GET /health',
      'POST /auth/invites/accept',
      'POST /auth/invites/complete',
      'POST /auth/invites/inspect',
      'POST /auth/login',
      'POST /auth/mfa/verify',
      'POST /auth/otp/request',
      'POST /auth/otp/verify',
      'POST /auth/refresh',
      'POST /display/board',
      'POST /platform/auth/login',
      'POST /platform/auth/mfa/verify',
      'POST /platform/auth/refresh',
      'POST /verify',
    ]);
  });

  it('puts every other platform endpoint behind the platform token, and nothing else', () => {
    const platformOps = Object.entries(doc.paths).flatMap(([path, ops]) =>
      Object.entries(ops)
        .filter(([, op]) =>
          JSON.stringify((op as { security?: unknown }).security ?? []).includes('platformAuth'),
        )
        .map(([method]) => `${method.toUpperCase()} ${path}`),
    );
    expect(platformOps.sort()).toEqual([
      'GET /platform/doctors',
      'GET /platform/health',
      'GET /platform/me',
      'GET /platform/organisations',
      'GET /platform/usage',
      'POST /platform/auth/logout',
      'POST /platform/doctors/{profileId}/verify',
      'POST /platform/organisations',
    ]);
  });

  it('describes query and path parameters', () => {
    const list = doc.paths['/patients']!.get as { parameters: { name: string }[] };
    expect(list.parameters.map((p) => p.name)).toEqual(['limit', 'cursor', 'q', 'tagId']);
    const get = doc.paths['/patients/{id}']!.get as { parameters: { in: string }[] };
    expect(get.parameters[0]!.in).toBe('path');
  });
});

describe('LoginResponse', () => {
  it('only ever leads to the authenticator step', () => {
    expect(LoginResponse.parse({ status: 'mfa_required', mfaToken: 't' }).status).toBe(
      'mfa_required',
    );
    expect(() =>
      LoginResponse.parse({ status: 'mfa_enrolment_required', mfaToken: 't' }),
    ).toThrow();
  });
});

describe('NewPassword', () => {
  it('requires at least 12 characters', () => {
    expect(() => NewPassword.parse('short')).toThrow();
    expect(NewPassword.parse('a long enough passphrase')).toBeTruthy();
  });
});

describe('checkUpload', () => {
  const limits = { maxUploadMb: 2, uploadTypes: ['pdf', 'heic'] as const };
  const mb = 1024 * 1024;

  it('accepts an allowed type within the size limit, whatever the media type’s case', () => {
    const settings = { ...limits, uploadTypes: [...limits.uploadTypes] };
    expect(checkUpload(settings, { mediaType: 'application/pdf', sizeBytes: 2 * mb })).toBe('ok');
    expect(checkUpload(settings, { mediaType: 'IMAGE/HEIF', sizeBytes: 1 })).toBe('ok');
  });

  it('refuses other types and files over the limit', () => {
    const settings = { ...limits, uploadTypes: [...limits.uploadTypes] };
    expect(checkUpload(settings, { mediaType: 'image/png', sizeBytes: 1 })).toBe(
      'type_not_allowed',
    );
    expect(checkUpload(settings, { mediaType: 'application/pdf', sizeBytes: 2 * mb + 1 })).toBe(
      'too_large',
    );
  });
});

describe('job queues', () => {
  it('names each queue once, in a fixed order', () => {
    expect(QUEUE_NAMES).toEqual(Object.values(QUEUES));
    expect(new Set(QUEUE_NAMES).size).toBe(QUEUE_NAMES.length);
  });
});

describe('PlatformHealth', () => {
  const health = {
    checkedAt: '2026-10-17T06:30:00.000Z',
    api: { version: '1.2.3', uptimeSeconds: 42 },
    database: { status: 'ok', latencyMs: 3, latestMigration: '20261017120000_platform_health' },
    queues: {
      status: 'ok',
      items: [{ name: 'messaging', waiting: 1, active: 0, delayed: 2, failed: 3 }],
    },
  };

  it('keeps status and counts only, dropping anything else a queue might carry', () => {
    const parsed = PlatformHealth.parse({
      ...health,
      queues: {
        status: 'ok',
        items: [{ ...health.queues.items[0], jobs: [{ data: { patientId: 'x' } }] }],
      },
    });
    expect(parsed.queues.items[0]).toEqual(health.queues.items[0]);
  });

  it('refuses unknown queues and statuses', () => {
    expect(
      PlatformHealth.safeParse({
        ...health,
        queues: { status: 'ok', items: [{ ...health.queues.items[0], name: 'other' }] },
      }).success,
    ).toBe(false);
    expect(
      PlatformHealth.safeParse({ ...health, database: { ...health.database, status: 'slow' } })
        .success,
    ).toBe(false);
    expect(
      PlatformHealth.safeParse({ ...health, queues: { status: 'not_configured', items: [] } })
        .success,
    ).toBe(true);
  });
});
