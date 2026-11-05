import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { systemRoutes } from './system';

describe('dependency readiness', () => {
  it('distinguishes a running process from unavailable dependencies without leaking errors', async () => {
    const app = Fastify();
    let available = false;
    app.register(systemRoutes, {
      prefix: '/v1',
      version: 'test',
      readiness: async () => {
        if (!available) throw new Error('postgresql://secret');
      },
    });
    try {
      expect((await app.inject('/v1/health')).statusCode).toBe(200);
      const failed = await app.inject('/v1/ready');
      expect(failed.statusCode).toBe(503);
      expect(failed.json()).toEqual({ status: 'unavailable' });
      expect(failed.headers['cache-control']).toBe('no-store');
      available = true;
      const ready = await app.inject('/v1/ready');
      expect(ready.statusCode).toBe(200);
      expect(ready.json()).toEqual({ status: 'ready' });
    } finally {
      await app.close();
    }
  });

  it('never declares an unconfigured API ready', async () => {
    const app = Fastify();
    app.register(systemRoutes, { version: 'test' });
    try {
      expect((await app.inject('/ready')).statusCode).toBe(503);
    } finally {
      await app.close();
    }
  });
});
