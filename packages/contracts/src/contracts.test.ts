import { describe, expect, it } from 'vitest';
import {
  CursorQuery,
  DEFAULT_PAGE_LIMIT,
  ErrorResponse,
  HealthResponse,
  LoginResponse,
  NewPassword,
  buildOpenApiDocument,
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

  it('marks only sign-in and health endpoints as public', () => {
    const publicOps = Object.entries(doc.paths).flatMap(([path, ops]) =>
      Object.entries(ops)
        .filter(([, op]) => Array.isArray((op as { security?: unknown[] }).security))
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
