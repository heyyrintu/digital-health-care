import { QUEUE_NAMES, type PlatformHealth, type PlatformQueueCounts } from '@dhc/contracts';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

export type QueueHealth = PlatformHealth['queues'];

/** How long system health waits for Redis before calling the queues down. */
export const QUEUE_CHECK_TIMEOUT_MS = 1_500;

/**
 * The background queues' job counts for the console's system health (PRD §9.3). Counts
 * only: no job is ever read, since payloads may reference an organisation or a patient.
 */
export interface QueueProbe {
  check(): Promise<QueueHealth>;
  /** Ends any check still running; called when the app closes. */
  close(): Promise<void>;
}

/** This API server has no `REDIS_URL`: the queues are not part of its health. */
export const queuesNotConfigured: QueueProbe = {
  check: async () => ({ status: 'not_configured', items: [] }),
  close: async () => {},
};

/**
 * Counts each queue's jobs with BullMQ's own `getJobCounts`, over a connection opened for
 * the check and closed after it. A long-lived connection would keep a failed start-up
 * forever (BullMQ caches it per queue) and retry in the background; one per check is a
 * fresh answer each time, and the console asks only when an operator opens or refreshes
 * the page. Redis that refuses, or does not answer within `timeoutMs`, is `down`.
 */
export class RedisQueueProbe implements QueueProbe {
  /** Checks still running, each with a way to end it at once. */
  private readonly running = new Set<() => void>();

  constructor(
    private readonly url: string,
    private readonly timeoutMs = QUEUE_CHECK_TIMEOUT_MS,
    /** BullMQ's key prefix; the workers use the default. Tests pass their own. */
    private readonly prefix?: string,
  ) {}

  async check(): Promise<QueueHealth> {
    const redis = new Redis(this.url, {
      connectTimeout: this.timeoutMs,
      // One attempt: a down Redis is reported, not waited for.
      retryStrategy: () => null,
      maxRetriesPerRequest: null,
    });
    // Connection errors are the answer (`down`), not a crash.
    redis.on('error', () => {});
    const queues = QUEUE_NAMES.map((name) => {
      const queue = new Queue(name, {
        connection: redis,
        ...(this.prefix ? { prefix: this.prefix } : {}),
      });
      queue.on('error', () => {});
      return queue;
    });
    let timer: NodeJS.Timeout | undefined;
    let stop = () => {};
    const stopped = new Promise<never>((_, reject) => {
      stop = () => reject(new Error('Queue check ended'));
      timer = setTimeout(stop, this.timeoutMs);
    });
    this.running.add(stop);
    try {
      const items = await Promise.race([Promise.all(queues.map(countJobs)), stopped]);
      return { status: 'ok', items };
    } catch {
      return { status: 'down', items: [] };
    } finally {
      clearTimeout(timer);
      this.running.delete(stop);
      // The queues share this connection and do not own it: drop it, then the queues.
      redis.disconnect();
      await Promise.allSettled(queues.map((queue) => queue.close()));
    }
  }

  async close(): Promise<void> {
    for (const stop of this.running) stop();
    this.running.clear();
  }
}

async function countJobs(queue: Queue): Promise<PlatformQueueCounts> {
  const counts = await queue.getJobCounts('waiting', 'prioritized', 'active', 'delayed', 'failed');
  return {
    name: queue.name as PlatformQueueCounts['name'],
    waiting: (counts.waiting ?? 0) + (counts.prioritized ?? 0),
    active: counts.active ?? 0,
    delayed: counts.delayed ?? 0,
    failed: counts.failed ?? 0,
  };
}
