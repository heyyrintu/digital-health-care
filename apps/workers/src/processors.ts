import type { Job } from 'bullmq';
import type { QueueName } from './queues';

export type Processor = (job: Job) => Promise<unknown>;

/**
 * Processors by queue. A queue without a processor gets no worker, so jobs wait safely
 * until its module ships. Job payloads carry IDs only — never patient data.
 */
export const processors: Partial<Record<QueueName, Processor>> = {
  system: async (job) => {
    if (job.name === 'ping') return { pong: true, at: new Date().toISOString() };
    throw new Error(`Unknown system job: ${job.name}`);
  },
};
