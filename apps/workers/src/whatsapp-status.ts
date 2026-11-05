import { withMessaging, type Db } from '@dhc/db';
import { Queue, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { z } from 'zod';
import { DEFAULT_JOB_OPTIONS } from './queues';

const Payload = z.object({ eventId: z.uuid() }).strict();

export function receiptProcessor(processEvent: (id: string) => Promise<unknown>) {
  return async (job: Job) => {
    if (job.name !== 'whatsapp-status') throw new Error('Unknown webhook job');
    const { eventId } = Payload.parse(job.data);
    await processEvent(eventId);
  };
}

/** Exported boundary keeps the bridge testable without Redis or a database. */
export async function publishReceipts(
  claim: () => Promise<{ id: string }[]>,
  publish: (eventId: string) => Promise<unknown>,
) {
  for (const event of await claim()) await publish(event.id);
}

export function startReceiptDispatch(db: Db, redisUrl: string) {
  // The publisher must fail promptly on Redis downtime. Blocking worker connections
  // intentionally use different options. The database lease will expire and retry.
  const connection = new Redis(redisUrl, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 5_000,
    commandTimeout: 5_000,
  });
  connection.on('error', () => {});
  const queue = new Queue('webhooks', { connection, skipWaitingForReady: true });
  queue.on('error', () => {});
  let active: Promise<void> | undefined;
  let stopping = false;
  const tick = () => {
    if (active || stopping) return;
    active = publishReceipts(
      () =>
        withMessaging(
          db,
          (tx) => tx.$queryRaw<{ id: string }[]>`SELECT id FROM messaging_claim_status_events()`,
        ),
      (eventId) =>
        queue.add(
          'whatsapp-status',
          { eventId },
          { ...DEFAULT_JOB_OPTIONS, jobId: `wa-${eventId}` },
        ),
    )
      .catch(() => {
        console.error('WhatsApp receipt dispatch unavailable; durable inbox will retry');
      })
      .finally(() => {
        active = undefined;
      });
  };
  const timer = setInterval(tick, 10_000);
  timer.unref();
  tick();
  return async () => {
    stopping = true;
    clearInterval(timer);
    await active;
    await queue.close();
    connection.disconnect();
  };
}
