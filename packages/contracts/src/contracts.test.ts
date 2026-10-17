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
  SavePrescriptionBody,
  TestOrderLine,
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
  it('names the queues in this order', () => {
    expect(QUEUE_NAMES).toEqual([
      'system',
      'messaging',
      'documents',
      'webhooks',
      'abdm',
      'imports',
      'reconciliation',
    ]);
    expect(Object.values(QUEUES)).toEqual(QUEUE_NAMES);
  });
});

describe('PlatformHealth', () => {
  const counts = (name: string, failed = 0) => ({
    name,
    waiting: 1,
    active: 0,
    delayed: 2,
    failed,
  });
  const items = QUEUE_NAMES.map((name) => counts(name, name === 'messaging' ? 3 : 0));
  const health = {
    checkedAt: '2026-10-17T06:30:00.000Z',
    api: { version: '1.2.3', uptimeSeconds: 42 },
    database: { status: 'ok', latencyMs: 3, latestMigration: '20261017120000_platform_health' },
    queues: { status: 'ok', items },
  };
  const withQueues = (queues: { status: string; items: unknown[] }) =>
    PlatformHealth.safeParse({ ...health, queues }).success;

  it('keeps status and counts only, dropping anything else a queue might carry', () => {
    const parsed = PlatformHealth.parse({
      ...health,
      queues: {
        status: 'ok',
        items: items.map((q) => ({ ...q, jobs: [{ data: { patientId: 'x' } }] })),
      },
    });
    expect(parsed.queues.items).toEqual(items);
  });

  it('takes every queue in order when ok, and none otherwise', () => {
    expect(withQueues({ status: 'ok', items })).toBe(true);
    expect(withQueues({ status: 'ok', items: [] })).toBe(false);
    expect(withQueues({ status: 'ok', items: items.slice(1) })).toBe(false);
    expect(withQueues({ status: 'ok', items: [...items].reverse() })).toBe(false);
    expect(withQueues({ status: 'ok', items: [...items, items[0]] })).toBe(false);
    expect(withQueues({ status: 'down', items: [] })).toBe(true);
    expect(withQueues({ status: 'not_configured', items: [] })).toBe(true);
    expect(withQueues({ status: 'down', items })).toBe(false);
  });

  it('refuses unknown queues and statuses', () => {
    expect(
      withQueues({ status: 'ok', items: items.map((q, i) => (i ? q : { ...q, name: 'other' })) }),
    ).toBe(false);
    expect(
      PlatformHealth.safeParse({ ...health, database: { ...health.database, status: 'slow' } })
        .success,
    ).toBe(false);
    expect(withQueues({ status: 'slow', items: [] })).toBe(false);
  });
});

describe('TestOrderLine', () => {
  const line = (over: Record<string, unknown> = {}) => ({
    id: '00000000-0000-4000-8000-000000000001',
    catalogueItemId: null,
    kind: 'mri',
    name: 'MRI',
    region: 'Knee',
    side: 'right',
    views: [],
    notes: null,
    ...over,
  });
  const fails = (over: Record<string, unknown>) =>
    TestOrderLine.safeParse(line(over)).error?.issues.map((i) => i.path.join('.'));

  it('takes imaging with a region and side, X-ray views, and blood tests without either', () => {
    expect(TestOrderLine.parse(line()).side).toBe('right');
    expect(TestOrderLine.safeParse(line({ kind: 'xray', views: ['AP', 'Lateral'] })).success).toBe(
      true,
    );
    expect(
      TestOrderLine.safeParse(line({ kind: 'blood', name: 'CBC', region: null, side: 'na' }))
        .success,
    ).toBe(true);
  });

  it('refuses a region or side on a blood test, views off an X-ray, and repeated views', () => {
    expect(fails({ kind: 'blood', side: 'na' })).toEqual(['region']);
    expect(fails({ kind: 'other', region: null })).toEqual(['side']);
    expect(fails({ views: ['AP'] })).toEqual(['views']);
    expect(fails({ kind: 'xray', views: ['AP', 'AP'] })).toEqual(['views']);
  });

  it('is optional on a prescription save, so older clients keep their tests', () => {
    const body = { language: 'en', items: [], revision: 0 };
    expect(SavePrescriptionBody.parse(body).tests).toBeUndefined();
    expect(SavePrescriptionBody.parse({ ...body, tests: [line()] }).tests).toHaveLength(1);
  });
});
