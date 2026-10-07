import type { Job } from 'bullmq';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';
import { processors } from './processors';
import { QUEUES } from './queues';

describe('queues', () => {
  it('has unique queue names', () => {
    const names = Object.values(QUEUES);
    expect(new Set(names).size).toBe(names.length);
  });

  it('only registers processors for known queues', () => {
    for (const queue of Object.keys(processors)) {
      expect(Object.values(QUEUES)).toContain(queue);
    }
  });
});

describe('system processor', () => {
  it('answers ping and rejects unknown jobs', async () => {
    await expect(processors.system!({ name: 'ping' } as Job)).resolves.toMatchObject({
      pong: true,
    });
    await expect(processors.system!({ name: 'other' } as Job)).rejects.toThrow(/Unknown/);
  });
});

describe('config', () => {
  it('defaults the Redis URL and rejects invalid values', () => {
    expect(loadConfig({}).REDIS_URL).toBe('redis://localhost:6379');
    expect(() => loadConfig({ REDIS_URL: 'not a url' })).toThrow();
    expect(() => loadConfig({ WORKER_CONCURRENCY: '0' })).toThrow();
  });
});
