/**
 * Background job queues (BullMQ, `apps/workers`): one per kind of slow or external work,
 * so the doctor's screen never waits on a third party (Build Plan §4). The names are part
 * of the API ↔ worker contract: the workers process them and the platform console's system
 * health counts their jobs (API guide §3s).
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

/**
 * Every queue name, in a fixed order (system health lists them in this order). A queue added
 * to `QUEUES` must be added here too; a contract test checks they match.
 */
export const QUEUE_NAMES = [
  QUEUES.system,
  QUEUES.messaging,
  QUEUES.documents,
  QUEUES.webhooks,
  QUEUES.abdm,
  QUEUES.imports,
  QUEUES.reconciliation,
] as const satisfies readonly QueueName[];
