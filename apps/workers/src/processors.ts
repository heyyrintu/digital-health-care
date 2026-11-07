import { reviewNoticeProcessor } from './review-notices';
import { operationalNoticeProcessor } from './operational-notices';
import { paymentNoticeProcessor } from './payment-notices';
import { reconciliationProcessor } from './reconciliation';
import type { QueueName } from '@dhc/contracts';
import type { Job } from 'bullmq';
import { withMessaging, type Db } from '@dhc/db';
import { recordNoticeProcessor } from './record-notices';
import { appointmentNoticeProcessor } from './appointment-notices';
import type { WorkerConfig } from './config';
import { receiptProcessor } from './whatsapp-status';

export type Processor = (job: Job) => Promise<unknown>;

/**
 * Processors by queue. A queue without a processor gets no worker, so jobs wait safely
 * until its module ships. Job payloads carry IDs only — never patient data.
 */
export function createProcessors(
  db?: Db,
  config?: WorkerConfig,
): Partial<Record<QueueName, Processor>> {
  return {
    ...(db && config?.CASHFREE_RECONCILIATION_ENABLED
      ? { reconciliation: reconciliationProcessor(db, config) }
      : {}),
    ...(db &&
    config &&
    (config.WHATSAPP_REVIEWS_ENABLED ||
      config.WHATSAPP_OPERATIONS_ENABLED ||
      config.WHATSAPP_APPOINTMENTS_ENABLED ||
      config.WHATSAPP_RECORDS_ENABLED ||
      config.WHATSAPP_PAYMENTS_ENABLED)
      ? {
          messaging: async (job: Job) => {
            if (job.name === 'review-request' && config.WHATSAPP_REVIEWS_ENABLED)
              return reviewNoticeProcessor(db, config)(job);
            if (job.name === 'appointment-update' && config.WHATSAPP_OPERATIONS_ENABLED)
              return operationalNoticeProcessor(db, config)(job);
            if (job.name === 'payment-notice' && config.WHATSAPP_PAYMENTS_ENABLED)
              return paymentNoticeProcessor(db, config)(job);
            if (job.name === 'appointment-notice' && config.WHATSAPP_APPOINTMENTS_ENABLED)
              return appointmentNoticeProcessor(db, config)(job);
            if (job.name === 'record-notice' && config.WHATSAPP_RECORDS_ENABLED)
              return recordNoticeProcessor(db, config)(job);
            throw new Error('Messaging job is unavailable');
          },
        }
      : {}),
    ...(db
      ? {
          webhooks: receiptProcessor((id) =>
            withMessaging(db, (tx) => tx.$executeRaw`SELECT messaging_process_status(${id}::uuid)`),
          ),
        }
      : {}),
    system: async (job) => {
      if (job.name === 'ping') return { pong: true, at: new Date().toISOString() };
      throw new Error(`Unknown system job: ${job.name}`);
    },
  };
}

export const processors = createProcessors();
