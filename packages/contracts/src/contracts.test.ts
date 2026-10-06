import { describe, expect, it } from 'vitest';
import {
  CursorQuery,
  DEFAULT_PAGE_LIMIT,
  ErrorResponse,
  HealthResponse,
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
  it('produces an OpenAPI 3.1 document with schema components', () => {
    const doc = buildOpenApiDocument({ version: '0.0.0' });
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.paths['/health'].get.operationId).toBe('getHealth');
    expect(doc.components.schemas.ErrorResponse).toMatchObject({ type: 'object' });
    expect(doc.components.schemas.HealthResponse).toMatchObject({
      required: expect.arrayContaining(['status', 'service', 'version', 'time']),
    });
  });
});
