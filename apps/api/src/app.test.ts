import { ErrorResponse, HealthResponse } from '@dhc/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildApp } from './app';
import { AppError } from './errors';
import { loadConfig } from './config';

const app = buildApp({ LOG_LEVEL: 'silent', APP_VERSION: '1.2.3' });

// Test-only routes that exercise each error path.
app.get('/v1/_test/app-error', async () => {
  throw new AppError(409, 'SLOT_TAKEN', 'This slot was just booked.', { slotStart: 'taken' });
});
app.get('/v1/_test/zod-error', async () => {
  z.object({ phone: z.string().min(10) }).parse({ phone: '12' });
});
app.get('/v1/_test/crash', async () => {
  throw new Error('database password is hunter2');
});

afterAll(() => app.close());

describe('GET /v1/health', () => {
  it('returns a valid health payload with a request id', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/health' });
    expect(res.statusCode).toBe(200);
    expect(HealthResponse.parse(res.json())).toMatchObject({ status: 'ok', version: '1.2.3' });
    expect(res.headers['x-request-id']).toMatch(/^req_/);
  });

  it('ignores a client-supplied request id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/health',
      headers: { 'request-id': 'spoofed' },
    });
    expect(res.headers['x-request-id']).not.toBe('spoofed');
  });
});

describe('GET /v1/openapi.json', () => {
  it('serves the generated OpenAPI document', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/openapi.json' });
    expect(res.json()).toMatchObject({ openapi: '3.1.0', info: { version: '1.2.3' } });
  });
});

describe('error shape', () => {
  const errorOf = async (url: string) => {
    const res = await app.inject({ method: 'GET', url });
    return { status: res.statusCode, body: ErrorResponse.parse(res.json()), raw: res.body };
  };

  it('renders unknown routes as NOT_FOUND', async () => {
    const { status, body } = await errorOf('/v1/nope');
    expect(status).toBe(404);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.requestId).toMatch(/^req_/);
  });

  it('renders AppError with its code and fields', async () => {
    const { status, body } = await errorOf('/v1/_test/app-error');
    expect(status).toBe(409);
    expect(body.error).toMatchObject({ code: 'SLOT_TAKEN', fields: { slotStart: 'taken' } });
  });

  it('renders validation failures with field messages', async () => {
    const { status, body } = await errorOf('/v1/_test/zod-error');
    expect(status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.fields).toHaveProperty('phone');
  });

  it('hides internal details of unexpected errors', async () => {
    const { status, body, raw } = await errorOf('/v1/_test/crash');
    expect(status).toBe(500);
    expect(body.error.code).toBe('INTERNAL');
    expect(raw).not.toContain('hunter2');
  });
});

describe('loadConfig', () => {
  it('applies defaults and rejects bad values', () => {
    expect(loadConfig({}).API_PORT).toBe(4000);
    expect(() => loadConfig({ API_PORT: 'abc' })).toThrow(/Invalid environment/);
  });
});
