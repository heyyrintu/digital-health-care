import { withMessaging, type Db } from '@dhc/db';
import { Queue, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { z } from 'zod';
import type { WorkerConfig } from './config';
import { DEFAULT_JOB_OPTIONS } from './queues';
import { publishReceipts } from './whatsapp-status';
import {
  sendAppointmentNotice,
  NoticeSendFailure,
  type AppointmentNotice,
} from './appointment-notices';
export function operationalNoticeProcessor(db: Db, config: WorkerConfig) {
  return async (job: Job) => {
    if (job.name !== 'appointment-update') throw new Error('Unknown messaging job');
    const { deliveryId } = z.object({ deliveryId: z.uuid() }).strict().parse(job.data);
    const sender = config.WHATSAPP_PHONE_NUMBER_ID!;
    const [notice] = await withMessaging(
      db,
      (tx) => tx.$queryRaw<AppointmentNotice[]>`
      SELECT * FROM messaging_begin_operational_notice(${deliveryId}::uuid, ${sender})`,
    );
    if (!notice) return;
    let message: string | null = null;
    let result: 'accepted' | 'submission_failed' | 'uncertain' = 'accepted';
    try {
      message = await sendAppointmentNotice(config, deliveryId, notice);
    } catch (e) {
      result = e instanceof NoticeSendFailure ? e.result : 'uncertain';
    }
    await withMessaging(
      db,
      (tx) => tx.$executeRaw`
      SELECT messaging_finish_operational_notice(${deliveryId}::uuid, ${sender}, ${result}, ${message})`,
    );
  };
}

export function startOperationalDispatch(db: Db, config: WorkerConfig) {
  const connection = new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 5_000,
    commandTimeout: 5_000,
  });
  connection.on('error', () => {});
  const queue = new Queue('messaging', { connection, skipWaitingForReady: true });
  queue.on('error', () => {});
  let active: Promise<void> | undefined;
  let stopping = false;
  const tick = () => {
    if (active || stopping) return;
    active = publishReceipts(
      () =>
        withMessaging(
          db,
          (tx) =>
            tx.$queryRaw<
              { id: string }[]
            >`SELECT id FROM messaging_claim_operational_notices(${config.WHATSAPP_PHONE_NUMBER_ID!})`,
        ),
      (deliveryId) =>
        queue.add(
          'appointment-update',
          { deliveryId },
          { ...DEFAULT_JOB_OPTIONS, jobId: `wa-notice-${deliveryId}` },
        ),
    )
      .catch(() => console.error('Operational dispatch unavailable; durable outbox will retry'))
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
