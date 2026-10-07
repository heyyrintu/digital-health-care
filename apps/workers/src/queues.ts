/**
 * One queue per kind of slow or external work, so the doctor's screen never waits on a
 * third party (Build Plan §4). Names are part of the API ↔ worker contract.
 */
export const QUEUES = {
  system: 'system',
  messaging: 'messaging',
  documents: 'documents',
  webhooks: 'webhooks',
  abdm: 'abdm',
  imports: 'imports',
  reconciliation: 'reconciliation',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

/** Retries with exponential backoff; final failures stay visible for the ops dashboard. */
export const DEFAULT_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: { age: 24 * 3600, count: 1000 },
  removeOnFail: false,
} as const;
