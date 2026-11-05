import {
  CreateReconRun,
  ReconDetail,
  ReconIssueList,
  ReconOverview,
  ReconSettlementList,
  ReviewReconIssue,
  CursorQuery,
} from '@dhc/contracts';
import { withPayments, withTenant, type Prisma } from '@dhc/db';
import { istToday } from '@dhc/reconciliation';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { AppError } from '../errors';
import { authenticate, authOf, requireRole } from '../plugins/authenticate';
import type { Services } from '../services';
import { writeAudit } from '../modules/audit/write';
const Id = z.object({ id: z.uuid() });
const Query = CursorQuery.extend({ cursor: z.uuid().optional() });
const missing = () => new AppError(404, 'NOT_FOUND', 'Reconciliation report not found.');
const out = (r: Prisma.CashfreeReconRunGetPayload<object>) => ({
  ...r,
  fromDate: r.fromDate.toISOString().slice(0, 10),
  toDate: r.toDate.toISOString().slice(0, 10),
  createdAt: r.createdAt.toISOString(),
  completedAt: r.completedAt?.toISOString() ?? null,
});
export const reconciliationRoutes: FastifyPluginAsync<{ services: Services }> = async (
  app,
  { services: s },
) => {
  const guard = { preHandler: [authenticate(s), requireRole('clinic_admin')] };
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('Cache-Control', 'no-store');
    return payload;
  });
  app.get('/reconciliation/runs', guard, async (req) => {
    const a = authOf(req),
      q = Query.parse(req.query);
    return withTenant(s.db, a.organisationId, async (tx) => {
      if (q.cursor && !(await tx.cashfreeReconRun.findUnique({ where: { id: q.cursor } })))
        throw missing();
      const rows = await tx.cashfreeReconRun.findMany({
        take: q.limit + 1,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      });
      return ReconOverview.parse({
        enabled: !!(s.cashfree?.reconciliationEnabled && s.cashfree.merchants[a.organisationId]),
        runs: {
          data: rows.slice(0, q.limit).map(out),
          nextCursor: rows.length > q.limit ? rows[q.limit - 1]!.id : null,
        },
      });
    });
  });
  app.post('/reconciliation/runs', guard, async (req) => {
    const a = authOf(req),
      body = CreateReconRun.parse(req.body),
      m = s.cashfree?.merchants[a.organisationId];
    if (!s.cashfree?.reconciliationEnabled || !m)
      throw new AppError(503, 'BUSINESS_RULE', 'Settlement reconciliation is not enabled.');
    if (body.toDate >= istToday(s.now()))
      throw new AppError(400, 'VALIDATION_FAILED', 'Choose a completed day before today.');
    try {
      return await withPayments(s.db, a.organisationId, async (tx) => {
        // Serialize duplicate submissions, including separate IDs for the same open period.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${a.organisationId},0))`;
        const existing = await tx.cashfreeReconRun.findUnique({ where: { id: body.id } });
        if (existing) {
          if (
            existing.fromDate.toISOString().slice(0, 10) !== body.fromDate ||
            existing.toDate.toISOString().slice(0, 10) !== body.toDate ||
            existing.merchantClientId !== m.clientId ||
            existing.environment !== m.environment
          )
            throw new AppError(409, 'CONFLICT', 'This request ID was already used.');
          return ReconDetail.parse({
            run: out(existing),
            unreviewedCount: await tx.cashfreeReconIssue.count({
              where: { runId: existing.id, severity: 'attention', reviewedAt: null },
            }),
          });
        }
        const open = await tx.cashfreeReconRun.findFirst({
          where: {
            merchantClientId: m.clientId,
            environment: m.environment,
            fromDate: new Date(body.fromDate),
            toDate: new Date(body.toDate),
            OR: [
              { status: { in: ['queued', 'running'] } },
              { status: 'failed', attempts: { lt: 5 } },
            ],
          },
        });
        if (open) return ReconDetail.parse({ run: out(open), unreviewedCount: 0 });
        const row = await tx.cashfreeReconRun.create({
          data: {
            id: body.id,
            organisationId: a.organisationId,
            requestedByUserId: a.userId,
            merchantClientId: m.clientId,
            environment: m.environment,
            fromDate: new Date(body.fromDate),
            toDate: new Date(body.toDate),
          },
        });
        await writeAudit(tx, req, {
          organisationId: a.organisationId,
          actorUserId: a.userId,
          action: 'reconciliation.request',
          entityType: 'reconciliation',
          entityId: row.id,
        });
        return ReconDetail.parse({ run: out(row), unreviewedCount: 0 });
      });
    } catch (e) {
      if (e && typeof e === 'object' && 'code' in e && e.code === 'P2002')
        throw new AppError(
          409,
          'CONFLICT',
          'A report was queued already. Refresh the report list.',
        );
      throw e;
    }
  });
  app.get('/reconciliation/runs/:id', guard, async (req) =>
    withTenant(s.db, authOf(req).organisationId, async (tx) => {
      const id = Id.parse(req.params).id,
        r = await tx.cashfreeReconRun.findUnique({ where: { id } });
      if (!r) throw missing();
      return ReconDetail.parse({
        run: out(r),
        unreviewedCount: await tx.cashfreeReconIssue.count({
          where: { runId: id, severity: 'attention', reviewedAt: null },
        }),
      });
    }),
  );
  for (const kind of ['issues', 'settlements'] as const)
    app.get(`/reconciliation/runs/:id/${kind}`, guard, async (req) =>
      withTenant(s.db, authOf(req).organisationId, async (tx) => {
        const id = Id.parse(req.params).id,
          q = Query.parse(req.query),
          r = await tx.cashfreeReconRun.findUnique({ where: { id } });
        if (!r) throw missing();
        const args = {
          where: { runId: id },
          take: q.limit + 1,
          orderBy: { id: 'asc' as const },
          ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
        };
        if (kind === 'issues') {
          if (
            q.cursor &&
            !(await tx.cashfreeReconIssue.findFirst({ where: { id: q.cursor, runId: id } }))
          )
            throw missing();
          const rows = await tx.cashfreeReconIssue.findMany(args);
          return ReconIssueList.parse({
            data: rows.slice(0, q.limit).map((r) => ({
              ...r,
              expectedPaise: r.expectedPaise === null ? null : Number(r.expectedPaise),
              reportedPaise: r.reportedPaise === null ? null : Number(r.reportedPaise),
              reviewedAt: r.reviewedAt?.toISOString() ?? null,
            })),
            nextCursor: rows.length > q.limit ? rows[q.limit - 1]!.id : null,
          });
        }
        if (
          q.cursor &&
          !(await tx.cashfreeReconSettlement.findFirst({ where: { id: q.cursor, runId: id } }))
        )
          throw missing();
        const rows = await tx.cashfreeReconSettlement.findMany(args);
        return ReconSettlementList.parse({
          data: rows.slice(0, q.limit).map((r) => ({
            ...r,
            grossPaise: Number(r.grossPaise),
            feesPaise: Number(r.feesPaise),
            taxPaise: Number(r.taxPaise),
            adjustmentPaise: Number(r.adjustmentPaise),
            netPaise: Number(r.netPaise),
          })),
          nextCursor: rows.length > q.limit ? rows[q.limit - 1]!.id : null,
        });
      }),
    );
  app.post('/reconciliation/issues/:id/review', guard, async (req) => {
    const a = authOf(req),
      id = Id.parse(req.params).id,
      body = ReviewReconIssue.parse(req.body);
    await withPayments(s.db, a.organisationId, async (tx) => {
      const row = await tx.cashfreeReconIssue.findUnique({ where: { id }, include: { run: true } });
      if (!row) throw missing();
      if (row.run.status !== 'succeeded')
        throw new AppError(409, 'CONFLICT', 'Wait for the complete report.');
      const updated = await tx.cashfreeReconIssue.updateMany({
        where: { id, reviewedAt: null },
        data: { reviewedAt: s.now(), reviewedByUserId: a.userId, reviewReason: body.reason },
      });
      if (updated.count)
        await writeAudit(tx, req, {
          organisationId: a.organisationId,
          actorUserId: a.userId,
          action: 'reconciliation.review',
          entityType: 'reconciliation',
          entityId: id,
          metadata: { reason: body.reason },
        });
    });
    return { reviewed: true };
  });
};
