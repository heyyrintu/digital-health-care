import { startReviewDispatch } from './review-notices';
import { startOperationalDispatch } from './operational-notices';
import { startPaymentDispatch } from './payment-notices';
import { startReconciliationDispatch } from './reconciliation';
import type { QueueName } from '@dhc/contracts';
import { Worker } from 'bullmq';
import { createRedis, loadConfig } from './config';
import { createProcessors } from './processors';
import { createDb } from '@dhc/db';
import { startRecordDispatch } from './record-notices';
import { startAppointmentDispatch } from './appointment-notices';
import { startReceiptDispatch } from './whatsapp-status';

const config = loadConfig();
const connection = createRedis(config.REDIS_URL);
const db = config.DATABASE_URL ? createDb(config.DATABASE_URL) : undefined;
const processors = createProcessors(db, config);
const stopReviews =
  db && config.WHATSAPP_REVIEWS_ENABLED ? startReviewDispatch(db, config) : async () => {};
const stopOperations =
  db && config.WHATSAPP_OPERATIONS_ENABLED ? startOperationalDispatch(db, config) : async () => {};
const stopAppointments =
  db && config.WHATSAPP_APPOINTMENTS_ENABLED
    ? startAppointmentDispatch(db, config)
    : async () => {};
const stopPayments =
  db && config.WHATSAPP_PAYMENTS_ENABLED ? startPaymentDispatch(db, config) : async () => {};
const stopRecords =
  db && config.WHATSAPP_RECORDS_ENABLED ? startRecordDispatch(db, config) : async () => {};
const stopReconciliation =
  db && config.CASHFREE_RECONCILIATION_ENABLED
    ? startReconciliationDispatch(db, config)
    : async () => {};
const stopDispatch = db ? startReceiptDispatch(db, config.REDIS_URL) : async () => {};

const workers = Object.entries(processors).map(
  ([queue, processor]) =>
    new Worker(queue as QueueName, processor, {
      connection,
      concurrency: config.WORKER_CONCURRENCY,
    }),
);

for (const worker of workers) {
  worker.on('error', () => console.error(`[${worker.name}] connection unavailable`));
  worker.on('failed', (job) => {
    // Job IDs and queue names only; payloads may reference patients.
    console.error(
      `[${worker.name}] job ${job?.id ?? '?'} failed; inspect the failed job for details`,
    );
  });
}

console.warn(`Workers started for queues: ${workers.map((w) => w.name).join(', ')}`);

const shutdown = async () => {
  await stopReviews();
  await stopReconciliation();
  await stopAppointments();
  await stopOperations();
  await stopRecords();
  await stopPayments();
  await stopDispatch();
  await Promise.all(workers.map((w) => w.close()));
  await db?.$disconnect();
  await connection.quit();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
