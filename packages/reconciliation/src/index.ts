import { randomUUID } from 'node:crypto';
import { allReportPages, ReportFailure, type Merchant, type ReportingGateway } from '@dhc/cashfree';
import { withPayments, type Db, type Tx } from '@dhc/db';
import {
  matchReports,
  normalizeEvent,
  normalizeSettlement,
  uniqueRows,
  type LocalOrder,
} from './match';
export * from './match';
export const MAX_ATTEMPTS = 5;
export function istToday(now: Date): string {
  return new Date(now.getTime() + 330 * 60000).toISOString().slice(0, 10);
}
export function reportBounds(from: Date, to: Date) {
  const start = new Date(from.getTime() - 330 * 60000),
    end = new Date(to.getTime() + 86400000 - 330 * 60000);
  return { start, end, from: start.toISOString(), to: new Date(end.getTime() - 1).toISOString() };
}
async function lock(tx: Tx, id: string) {
  await tx.$queryRaw`SELECT id FROM cashfree_recon_runs WHERE id=${id}::uuid FOR UPDATE`;
  return tx.cashfreeReconRun.findUnique({ where: { id } });
}
class LostLease extends Error {}
/** Full scans happen outside transactions. Only complete, fenced snapshots are published. */
export async function processRun(
  db: Db,
  organisationId: string,
  runId: string,
  merchant: Merchant | undefined,
  gateway: ReportingGateway,
  now: () => Date = () => new Date(),
) {
  const token = randomUUID();
  const run = await withPayments(db, organisationId, async (tx) => {
    const r = await lock(tx, runId),
      at = now();
    if (
      !r ||
      r.status === 'succeeded' ||
      r.attempts >= MAX_ATTEMPTS ||
      (r.status === 'running' && r.leaseUntil && r.leaseUntil > at) ||
      (r.retryAt && r.retryAt > at)
    )
      return null;
    return tx.cashfreeReconRun.update({
      where: { id: runId },
      data: {
        status: 'running',
        attempts: { increment: 1 },
        leaseToken: token,
        leaseUntil: new Date(at.getTime() + 60000),
        startedAt: at,
        retryAt: null,
        errorCode: null,
      },
    });
  });
  if (!run) return;
  const heartbeat = async () => {
    const at = now();
    const result = await withPayments(db, organisationId, (tx) =>
      tx.cashfreeReconRun.updateMany({
        where: { id: runId, status: 'running', leaseToken: token, leaseUntil: { gt: at } },
        data: { leaseUntil: new Date(at.getTime() + 60000) },
      }),
    );
    if (result.count !== 1) throw new LostLease();
  };
  try {
    if (
      !merchant ||
      merchant.clientId !== run.merchantClientId ||
      merchant.environment !== run.environment
    )
      throw new Error('binding_changed');
    const b = reportBounds(run.fromDate, run.toDate);
    const settlements = uniqueRows(
      (await allReportPages((c) => gateway.settlements(merchant, b.from, b.to, c), heartbeat)).map(
        normalizeSettlement,
      ),
      (s) => s.settlementId,
    );
    const events = (
      await allReportPages((c) => gateway.events(merchant, b.from, b.to, c), heartbeat)
    ).map((e) => normalizeEvent(e, 'pg'));
    for (let i = 0; i < settlements.length; i += 20) {
      const ids = settlements.slice(i, i + 20).map((s) => s.settlementId);
      const rows = (
        await allReportPages((c) => gateway.settlementEvents(merchant, ids, c), heartbeat)
      ).map((e) => normalizeEvent(e, 'settlement'));
      if (rows.some((e) => !e.settlementId || !ids.includes(e.settlementId)))
        throw new ReportFailure('invalid_report');
      events.push(...rows);
      if (events.length > 20000) throw new ReportFailure('limit_exceeded');
    }
    const distinct = uniqueRows(events, (e) => `${e.stream}:${e.eventKey}`);
    await heartbeat();
    await withPayments(
      db,
      organisationId,
      async (tx) => {
        const current = await lock(tx, runId);
        if (
          current?.status !== 'running' ||
          current.leaseToken !== token ||
          !current.leaseUntil ||
          current.leaseUntil <= now()
        )
          throw new LostLease();
        const references = [
          ...new Set(distinct.flatMap((e) => (e.orderReference ? [e.orderReference] : []))),
        ];
        const rows = await tx.cashfreeOrder.findMany({
          take: 10001,
          where: {
            OR: [
              { providerOrderId: { in: references } },
              { payment: { receivedAt: { gte: b.start, lt: b.end } } },
              { refunds: { some: { entry: { postedAt: { gte: b.start, lt: b.end } } } } },
            ],
          },
          include: {
            bill: { select: { appointmentId: true } },
            payment: true,
            refunds: { include: { entry: true } },
          },
        });
        if (rows.length > 10000) throw new ReportFailure('limit_exceeded');
        const orders: LocalOrder[] = rows.map((o) => ({
          ...o,
          appointmentId: o.bill.appointmentId,
        }));
        const issues = matchReports(distinct, settlements, orders, merchant, b.start, b.end);
        for (let i = 0; i < settlements.length; i += 200)
          await tx.cashfreeReconSettlement.createMany({
            data: settlements.slice(i, i + 200).map((s) => ({ ...s, runId, organisationId })),
          });
        for (let i = 0; i < distinct.length; i += 200)
          await tx.cashfreeReconEvent.createMany({
            data: distinct.slice(i, i + 200).map((e) => ({ ...e, runId, organisationId })),
          });
        for (let i = 0; i < issues.length; i += 200)
          await tx.cashfreeReconIssue.createMany({
            data: issues.slice(i, i + 200).map((e) => ({ ...e, runId, organisationId })),
          });
        await tx.cashfreeReconRun.update({
          where: { id: runId },
          data: {
            status: 'succeeded',
            completedAt: now(),
            eventCount: distinct.length,
            settlementCount: settlements.length,
            mismatchCount: issues.filter((i) => i.severity === 'attention').length,
            leaseToken: null,
            leaseUntil: null,
            dispatchLeaseAt: null,
          },
        });
      },
      { maxWait: 5000, timeout: 30000, isolationLevel: 'RepeatableRead' },
    );
  } catch (e) {
    if (e instanceof LostLease) return;
    const errorCode =
      e instanceof ReportFailure
        ? e.code
        : e instanceof Error && e.message === 'binding_changed'
          ? 'binding_changed'
          : 'processing_failed';
    await withPayments(db, organisationId, (tx) =>
      tx.cashfreeReconRun.updateMany({
        where: { id: runId, status: 'running', leaseToken: token },
        data: {
          status: 'failed',
          errorCode,
          leaseToken: null,
          leaseUntil: null,
          dispatchLeaseAt: null,
          retryAt: new Date(now().getTime() + Math.min(3600000, 30000 * 2 ** run.attempts)),
        },
      }),
    );
  }
}
/** Once per IST day after 01:00, scan a rolling period ending yesterday. */
export async function scheduleNightly(
  db: Db,
  organisationId: string,
  merchant: Merchant,
  lookback: number,
  now: Date,
) {
  const local = new Date(now.getTime() + 330 * 60000);
  if (local.getUTCHours() < 1) return;
  const today = istToday(now),
    end = new Date(`${today}T00:00:00.000Z`);
  end.setUTCDate(end.getUTCDate() - 1);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - lookback + 1);
  await withPayments(db, organisationId, (tx) =>
    tx.cashfreeReconRun.createMany({
      skipDuplicates: true,
      data: {
        id: randomUUID(),
        organisationId,
        merchantClientId: merchant.clientId,
        environment: merchant.environment,
        fromDate: start,
        toDate: end,
        nightlyKey: today,
      },
    }),
  );
}
export async function claimDispatch(db: Db, organisationId: string, now: Date) {
  return withPayments(db, organisationId, async (tx) => {
    // A crash on the last permitted attempt must not leave a run permanently running.
    await tx.cashfreeReconRun.updateMany({
      where: { status: 'running', attempts: { gte: MAX_ATTEMPTS }, leaseUntil: { lte: now } },
      data: {
        status: 'failed',
        errorCode: 'processing_failed',
        leaseToken: null,
        leaseUntil: null,
        dispatchLeaseAt: null,
        retryAt: null,
      },
    });
    const rows = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id FROM cashfree_recon_runs WHERE organisation_id=${organisationId}::uuid AND attempts<5 AND (status='queued' OR (status='failed' AND retry_at<=${now}) OR (status='running' AND lease_until<=${now})) AND (dispatch_lease_at IS NULL OR dispatch_lease_at<${new Date(now.getTime() - 60000)}) ORDER BY created_at LIMIT 20 FOR UPDATE SKIP LOCKED`;
    if (rows.length)
      await tx.cashfreeReconRun.updateMany({
        where: { id: { in: rows.map((r) => r.id) } },
        data: { dispatchLeaseAt: now },
      });
    return rows;
  });
}
