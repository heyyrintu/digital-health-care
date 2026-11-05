import { CashfreeReportingGateway, parseMerchants } from '@dhc/cashfree';
import { claimDispatch, processRun, scheduleNightly } from '@dhc/reconciliation';
import type { Db } from '@dhc/db';
import { Queue, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { WorkerConfig } from './config';
const Payload = z.object({ organisationId: z.uuid(), runId: z.uuid() }).strict();
export function reconciliationProcessor(db: Db, config: WorkerConfig) {
  const merchants = parseMerchants(config.CASHFREE_MERCHANTS_JSON!);
  const gateway = new CashfreeReportingGateway();
  return async (job: Job) => {
    if (job.name !== 'cashfree-reconciliation') throw new Error('Unknown reconciliation job');
    const p = Payload.parse(job.data);
    await processRun(db, p.organisationId, p.runId, merchants[p.organisationId], gateway);
  };
}
export function startReconciliationDispatch(db: Db, config: WorkerConfig) {
  const merchants = parseMerchants(config.CASHFREE_MERCHANTS_JSON!);
  const connection = new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 5000,
    commandTimeout: 5000,
  });
  connection.on('error', () => {});
  const queue = new Queue('reconciliation', { connection, skipWaitingForReady: true });
  queue.on('error', () => {});
  let active: Promise<void> | undefined,
    stopping = false;
  const tick = () => {
    if (active || stopping) return;
    active = (async () => {
      for (const [organisationId, merchant] of Object.entries(merchants)) {
        try {
          await scheduleNightly(
            db,
            organisationId,
            merchant,
            config.CASHFREE_RECONCILIATION_LOOKBACK_DAYS,
            new Date(),
          );
          for (const r of await claimDispatch(db, organisationId, new Date()))
            await queue.add(
              'cashfree-reconciliation',
              { organisationId, runId: r.id },
              {
                jobId: `recon-${r.id}-${randomUUID()}`,
                attempts: 1,
                removeOnComplete: { age: 86400, count: 1000 },
                removeOnFail: { age: 604800, count: 1000 },
              },
            );
        } catch {
          console.error('Clinic reconciliation dispatch unavailable; durable runs will retry');
        }
      }
    })()
      .catch(() => console.error('Reconciliation dispatch unavailable; durable runs will retry'))
      .finally(() => {
        active = undefined;
      });
  };
  const timer = setInterval(tick, 15000);
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
