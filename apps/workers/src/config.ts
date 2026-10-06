import { Redis } from 'ioredis';
import { z } from 'zod';

const Env = z.object({
  REDIS_URL: z.url().default('redis://localhost:6379'),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(5),
});

export type WorkerConfig = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const parsed = Env.safeParse(env);
  if (!parsed.success) throw new Error(`Invalid environment: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

/**
 * Redis client for BullMQ. BullMQ needs a ready-made client under ESM, and blocking
 * worker commands require `maxRetriesPerRequest: null`. `rediss://` URLs enable TLS.
 */
export function createRedis(url: string): Redis {
  return new Redis(url, { maxRetriesPerRequest: null });
}
