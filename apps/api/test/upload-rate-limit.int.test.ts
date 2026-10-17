/**
 * Result uploads share one limit per address across the staff and Patient app routes
 * (API guide §1, §3t). Its own harness, so its counter starts empty and no other suite
 * runs out of uploads.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createHarness } from './harness';

const h = createHarness();

afterAll(async () => {
  await h.app.close();
  await h.owner.$disconnect();
});

const post = (url: string) =>
  h.app.inject({
    method: 'POST',
    url: `/v1${url}/${randomUUID()}/results`,
    headers: { 'content-type': 'application/pdf' },
    payload: Buffer.from('%PDF-1.7\n'),
  });

describe('upload rate limit', () => {
  it('counts staff and portal uploads together, 60 a minute per address', async () => {
    // Counted before authentication, so anonymous floods are held back too.
    for (let i = 0; i < 30; i++) {
      expect((await post('/test-orders')).statusCode).toBe(401);
      expect((await post('/portal/test-orders')).statusCode).toBe(401);
    }
    const staff = await post('/test-orders');
    expect(staff.statusCode).toBe(429);
    expect(staff.json().error.code).toBe('RATE_LIMITED');
    expect((await post('/portal/test-orders')).statusCode).toBe(429);
    // Other endpoints keep their own limits.
    expect((await h.app.inject({ method: 'GET', url: '/v1/health' })).statusCode).toBe(200);
  });
});
