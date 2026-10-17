/**
 * Queue names live in `@dhc/contracts` (`QUEUES`), shared with the API, whose platform
 * console counts each queue's jobs (system health).
 */

/** Retries with exponential backoff; final failures stay visible in the console's system health. */
export const DEFAULT_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: { age: 24 * 3600, count: 1000 },
  removeOnFail: false,
} as const;
