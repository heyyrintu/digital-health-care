import { Worker } from 'bullmq';
import { createRedis, loadConfig } from './config';
import { processors } from './processors';
import type { QueueName } from './queues';

const config = loadConfig();
const connection = createRedis(config.REDIS_URL);

const workers = Object.entries(processors).map(
  ([queue, processor]) =>
    new Worker(queue as QueueName, processor, {
      connection,
      concurrency: config.WORKER_CONCURRENCY,
    }),
);

for (const worker of workers) {
  worker.on('failed', (job, error) => {
    // Job IDs and queue names only; payloads may reference patients.
    console.error(`[${worker.name}] job ${job?.id ?? '?'} failed: ${error.message}`);
  });
}

console.warn(`Workers started for queues: ${workers.map((w) => w.name).join(', ')}`);

const shutdown = async () => {
  await Promise.all(workers.map((w) => w.close()));
  await connection.quit();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
