import type { CreateRefundBody, Refund, RefundView, RefundVoucher } from '@dhc/contracts';
import { withPayments, withTenant, type Prisma, type Tx } from '@dhc/db';
import { createHash, randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../errors';
import type { Services } from '../services';
import { writeAudit } from '../modules/audit/write';
import { BillingService } from '../modules/billing/service';
import { toPaise, type ProviderRefund } from './cashfree';

type Order = Prisma.CashfreeOrderGetPayload<object>;
type RequestRow = Prisma.CashfreeRefundGetPayload<object>;
interface Actor {
  organisationId: string;
  userId: string;
  role: 'clinic_admin' | 'doctor' | 'front_desk' | 'patient';
}
const OPEN = ['creating', 'pending', 'review'];
const missing = () => new AppError(404, 'NOT_FOUND', 'Refund not found.');
const conflict = (message: string) => new AppError(409, 'CONFLICT', message);
const unavailable = () =>
  new AppError(
    503,
    'BUSINESS_RULE',
    'Refund provider is unavailable. Check the existing refund before trying again.',
  );
export class RefundService {
  constructor(private readonly s: Services) {}
  private config() {
    if (!this.s.cashfree?.refundGateway) throw unavailable();
    return { integration: this.s.cashfree, gateway: this.s.cashfree.refundGateway };
  }
  private merchant(order: Order) {
    const row = this.config().integration.merchants[order.organisationId];
    if (!row || row.clientId !== order.merchantClientId || row.environment !== order.environment)
      throw conflict('Configure the original clinic payment account to check this refund.');
    return row;
  }
  private async out(tx: Tx, row: RequestRow): Promise<Refund> {
    const entry = await tx.refundEntry.findUnique({ where: { refundId: row.id } });
    return {
      providerReference: row.providerRefundId,
      id: row.id,
      paymentId: row.paymentId,
      amountPaise: row.amountPaise,
      status: row.status as Refund['status'],
      origin: row.origin as Refund['origin'],
      reason: row.reason,
      createdAt: row.createdAt.toISOString(),
      postedAt: entry?.postedAt.toISOString() ?? null,
      voucherNumber: entry?.voucherNumber ?? null,
    };
  }
  async view(actor: Actor, billId: string): Promise<RefundView> {
    return withTenant(this.s.db, actor.organisationId, async (tx) => {
      if (!(await tx.bill.findUnique({ where: { id: billId } }))) throw missing();
      const payments = await tx.payment.findMany({
          where: { billId, mode: 'cashfree' },
          orderBy: { receivedAt: 'asc' },
        }),
        rows = await tx.cashfreeRefund.findMany({
          where: { billId },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        });
      const orders = await tx.cashfreeOrder.findMany({ where: { billId, status: 'paid' } });
      const amounts = (id: string, statuses: string[]) =>
        rows
          .filter((r) => r.paymentId === id && statuses.includes(r.status))
          .reduce((n, r) => n + r.amountPaise, 0);
      return {
        available: !!this.s.cashfree?.refundGateway,
        enabled:
          !!this.s.cashfree?.refundsEnabled &&
          !!this.s.cashfree.refundGateway &&
          orders.every((o) => {
            const m = this.s.cashfree?.merchants[o.organisationId];
            return m?.clientId === o.merchantClientId && m.environment === o.environment;
          }),
        reviewRequired: orders.some((o) => o.refundReviewRequired),
        refundedPaise: rows
          .filter((r) => r.status === 'succeeded')
          .reduce((n, r) => n + r.amountPaise, 0),
        pendingPaise: rows
          .filter((r) => OPEN.includes(r.status))
          .reduce((n, r) => n + r.amountPaise, 0),
        payments: payments.map((p) => ({
          id: p.id,
          receiptNumber: p.receiptNumber,
          amountPaise: p.amountPaise,
          refundablePaise: Math.max(0, p.amountPaise - amounts(p.id, [...OPEN, 'succeeded'])),
          hasPending: rows.some((r) => r.paymentId === p.id && OPEN.includes(r.status)),
        })),
        refunds: await Promise.all(rows.map((r) => this.out(tx, r))),
      };
    });
  }
  private async source(organisationId: string, paymentId: string) {
    return withTenant(this.s.db, organisationId, async (tx) => {
      const payment = await tx.payment.findUnique({
        where: { id: paymentId },
        include: { cashfreeOrder: true },
      });
      if (!payment) throw missing();
      if (
        payment.mode !== 'cashfree' ||
        !payment.cashfreeOrder ||
        payment.cashfreeOrder.status !== 'paid' ||
        payment.reference !== payment.cashfreeOrder.providerPaymentId
      )
        throw conflict('Only a verified Cashfree payment can be refunded here.');
      return { payment, order: payment.cashfreeOrder };
    });
  }
  async create(request: FastifyRequest, actor: Actor, paymentId: string, body: CreateRefundBody) {
    const { integration, gateway } = this.config();
    if (!integration.refundsEnabled) throw conflict('New refunds are not enabled.');
    const { payment, order } = await this.source(actor.organisationId, paymentId),
      merchant = this.merchant(order);
    const prior = await withTenant(this.s.db, actor.organisationId, (tx) =>
      tx.cashfreeRefund.findUnique({ where: { id: body.id } }),
    );
    if (prior) {
      if (
        prior.paymentId !== paymentId ||
        prior.amountPaise !== body.amountPaise ||
        prior.reason !== body.reason
      )
        throw conflict('This refund request ID is already in use.');
      return this.retry(request, actor, prior.id);
    }
    try {
      // Bring external/dashboard refunds into the ledger before reserving any more funds.
      const refunds = await gateway.refunds(merchant, order.providerOrderId);
      for (const remote of refunds) await this.apply(request, order, remote);
      const transactions = await integration.gateway.payments(merchant, order.providerOrderId);
      const success = transactions.filter((p) => p.payment_status === 'SUCCESS');
      let matches =
        success.length === 1 &&
        success[0]!.order_id === order.providerOrderId &&
        success[0]!.cf_payment_id === order.providerPaymentId &&
        success[0]!.payment_currency === order.currency &&
        success[0]!.is_captured !== false;
      try {
        matches = matches && toPaise(success[0]!.payment_amount) === payment.amountPaise;
      } catch {
        matches = false;
      }
      if (!matches) {
        await this.markReview(request, order);
        throw conflict('The original payment needs review before a refund can be requested.');
      }
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw unavailable();
    }
    const row = await withPayments(this.s.db, actor.organisationId, async (tx) => {
      await tx.$queryRaw`SELECT id FROM bills WHERE id=${order.billId}::uuid FOR UPDATE`;
      const duplicate = await tx.cashfreeRefund.findUnique({ where: { id: body.id } });
      if (duplicate) {
        if (
          duplicate.paymentId !== paymentId ||
          duplicate.amountPaise !== body.amountPaise ||
          duplicate.reason !== body.reason
        )
          throw conflict('This refund request ID is already in use.');
        return duplicate;
      }
      const current = await tx.cashfreeOrder.findUniqueOrThrow({ where: { id: order.id } });
      if (
        current.refundReviewRequired ||
        (await tx.cashfreeEvent.findFirst({ where: { orderId: order.id, outcome: 'review' } }))
      )
        throw conflict('This payment needs review before requesting a refund.');
      const rows = await tx.cashfreeRefund.findMany({ where: { paymentId } });
      if (rows.some((r) => OPEN.includes(r.status)))
        throw conflict('Check the existing refund before starting another.');
      const reserved = rows
        .filter((r) => r.status === 'succeeded')
        .reduce((n, r) => n + r.amountPaise, 0);
      if (body.amountPaise > payment.amountPaise - reserved)
        throw conflict('The amount exceeds the remaining refundable payment.');
      const created = await tx.cashfreeRefund.create({
        data: {
          id: body.id,
          organisationId: actor.organisationId,
          billId: order.billId,
          orderId: order.id,
          paymentId,
          merchantRefundId: 'rf' + body.id.replaceAll('-', ''),
          amountPaise: body.amountPaise,
          origin: 'app',
          reason: body.reason,
          requestedByUserId: actor.userId,
        },
      });
      await writeAudit(tx, request, {
        action: 'refund.requested',
        organisationId: actor.organisationId,
        actorUserId: actor.userId,
        entityType: 'cashfree_refund',
        entityId: created.id,
        metadata: { paymentId, amountPaise: body.amountPaise, reason: body.reason },
      });
      return created;
    });
    if (row.status === 'creating') await this.submit(request, order, row);
    return this.view(actor, order.billId);
  }
  async retry(request: FastifyRequest, actor: Actor, id: string) {
    if (!this.config().integration.refundsEnabled) throw conflict('New refunds are not enabled.');
    const row = await withTenant(this.s.db, actor.organisationId, (tx) =>
      tx.cashfreeRefund.findUnique({ where: { id } }),
    );
    if (!row) throw missing();
    if (row.status === 'creating' && row.origin === 'app') {
      const { order } = await this.source(actor.organisationId, row.paymentId);
      await this.submit(request, order, row);
    }
    return this.view(actor, row.billId);
  }
  private async submit(request: FastifyRequest, order: Order, row: RequestRow) {
    const { gateway } = this.config(),
      merchant = this.merchant(order);
    try {
      const remote =
        (await gateway.refund(merchant, order.providerOrderId, row.merchantRefundId)) ??
        (await gateway.createRefund(merchant, {
          id: row.id,
          orderId: order.providerOrderId,
          refundId: row.merchantRefundId,
          amountPaise: row.amountPaise,
        }));
      await this.apply(request, order, remote, row.id);
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw unavailable();
    }
  }
  async check(request: FastifyRequest, actor: Actor, id: string) {
    const row = await withTenant(this.s.db, actor.organisationId, (tx) =>
      tx.cashfreeRefund.findUnique({ where: { id } }),
    );
    if (!row) throw missing();
    const { order } = await this.source(actor.organisationId, row.paymentId),
      { gateway } = this.config();
    try {
      const remote = await gateway.refund(
        this.merchant(order),
        order.providerOrderId,
        row.merchantRefundId,
      );
      if (!remote)
        throw conflict(
          'The provider has not confirmed this refund. Keep the original request for recovery.',
        );
      await this.apply(request, order, remote, row.id);
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw unavailable();
    }
    return this.view(actor, row.billId);
  }
  async sync(request: FastifyRequest, actor: Actor, paymentId: string) {
    const { order } = await this.source(actor.organisationId, paymentId),
      { gateway } = this.config();
    try {
      for (const remote of await gateway.refunds(this.merchant(order), order.providerOrderId))
        await this.apply(request, order, remote);
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw unavailable();
    }
    return this.view(actor, order.billId);
  }
  private async markReview(request: FastifyRequest, order: Order) {
    await withPayments(this.s.db, order.organisationId, async (tx) => {
      await tx.$queryRaw`SELECT id FROM bills WHERE id=${order.billId}::uuid FOR UPDATE`;
      await tx.cashfreeOrder.update({
        where: { id: order.id },
        data: { refundReviewRequired: true },
      });
      await writeAudit(tx, request, {
        action: 'refund.review_required',
        organisationId: order.organisationId,
        entityType: 'cashfree_order',
        entityId: order.id,
      });
    });
  }
  /** Authenticated provider state only. Success posts once; later failures never reverse it. */
  async apply(
    request: FastifyRequest,
    order: Order,
    remote: ProviderRefund,
    expectedId?: string,
    raw?: Buffer,
  ) {
    this.merchant(order);
    await withPayments(this.s.db, order.organisationId, async (tx) => {
      await tx.$queryRaw`SELECT id FROM bills WHERE id=${order.billId}::uuid FOR UPDATE`;
      const eventHash = raw ? createHash('sha256').update(raw).digest('hex') : null;
      if (
        eventHash &&
        (await tx.cashfreeRefundEvent.findUnique({
          where: { organisationId_eventHash: { organisationId: order.organisationId, eventHash } },
        }))
      )
        return;
      const payment = await tx.payment.findUnique({ where: { cashfreeOrderId: order.id } });
      let row = await tx.cashfreeRefund.findUnique({
        where: {
          orderId_merchantRefundId: { orderId: order.id, merchantRefundId: remote.refund_id },
        },
      });
      const used = await tx.cashfreeRefund.findFirst({
        where: {
          orderId: order.id,
          providerRefundId: remote.cf_refund_id,
          ...(row ? { id: { not: row.id } } : {}),
        },
      });
      let amount: number | null = null;
      try {
        amount = toPaise(remote.refund_amount);
      } catch {
        /* Invalid amounts require review. */
      }
      let valid =
        !!payment &&
        order.status === 'paid' &&
        remote.order_id === order.providerOrderId &&
        remote.cf_payment_id === order.providerPaymentId &&
        remote.refund_currency === order.currency &&
        amount !== null &&
        amount > 0 &&
        amount <= payment.amountPaise &&
        !used;
      if (expectedId && (!row || row.id !== expectedId)) valid = false;
      if (
        row &&
        (row.amountPaise !== amount ||
          (row.providerRefundId && row.providerRefundId !== remote.cf_refund_id))
      )
        valid = false;
      let outcome = 'review';
      if (valid && payment && amount !== null) {
        if (!row)
          row = await tx.cashfreeRefund.create({
            data: {
              id: randomUUID(),
              organisationId: order.organisationId,
              orderId: order.id,
              billId: order.billId,
              paymentId: payment.id,
              merchantRefundId: remote.refund_id,
              providerRefundId: remote.cf_refund_id,
              amountPaise: amount,
              origin: 'provider',
              reason: 'provider_recorded',
              status: 'pending',
            },
          });
        const state =
          remote.refund_status === 'SUCCESS'
            ? 'succeeded'
            : ['CANCELLED', 'REJECTED'].includes(remote.refund_status)
              ? remote.refund_status.toLowerCase()
              : remote.refund_status === 'FAILED'
                ? 'review'
                : 'pending';
        if (row.status === 'succeeded') outcome = 'ignored';
        else if (state === 'succeeded') {
          const posted = await tx.refundEntry.aggregate({
            where: { paymentId: payment.id },
            _sum: { amountPaise: true },
          });
          if ((posted._sum.amountPaise ?? 0) + amount > payment.amountPaise) valid = false;
          else {
            await tx.cashfreeRefund.update({
              where: { id: row.id },
              data: {
                status: 'succeeded',
                providerRefundId: remote.cf_refund_id,
                checkedAt: this.s.now(),
              },
            });
            const [number] = await tx.$queryRaw<
              { n: number }[]
            >`INSERT INTO refund_settings(organisation_id,next_number) VALUES(${order.organisationId}::uuid,2) ON CONFLICT(organisation_id) DO UPDATE SET next_number=refund_settings.next_number+1 RETURNING next_number-1 AS n`;
            await tx.refundEntry.create({
              data: {
                refundId: row.id,
                organisationId: order.organisationId,
                billId: order.billId,
                paymentId: payment.id,
                amountPaise: amount,
                voucherNumber: 'RF' + String(number!.n).padStart(5, '0'),
                postedAt: this.s.now(),
              },
            });
            outcome = 'succeeded';
          }
        } else if (!['cancelled', 'rejected'].includes(row.status)) {
          await tx.cashfreeRefund.update({
            where: { id: row.id },
            data: { status: state, providerRefundId: remote.cf_refund_id, checkedAt: this.s.now() },
          });
          outcome = state;
        } else outcome = 'ignored';
      }
      if (!valid || outcome === 'review') {
        if (row && !['succeeded', 'cancelled', 'rejected'].includes(row.status))
          await tx.cashfreeRefund.update({
            where: { id: row.id },
            data: { status: 'review', checkedAt: this.s.now() },
          });
        await tx.cashfreeOrder.update({
          where: { id: order.id },
          data: { refundReviewRequired: true },
        });
        outcome = 'review';
      }
      if (eventHash)
        await tx.cashfreeRefundEvent.create({
          data: {
            organisationId: order.organisationId,
            orderId: order.id,
            eventHash,
            merchantRefundId: remote.refund_id,
            providerRefundId: remote.cf_refund_id,
            outcome,
          },
        });
      await writeAudit(tx, request, {
        action:
          outcome === 'succeeded'
            ? 'refund.confirmed'
            : outcome === 'review'
              ? 'refund.review_required'
              : 'refund.checked',
        organisationId: order.organisationId,
        entityType: 'cashfree_refund',
        entityId: row?.id ?? order.id,
        metadata: { outcome, paymentId: payment?.id ?? null },
      });
    });
  }
  async voucher(request: FastifyRequest, actor: Actor, id: string): Promise<RefundVoucher> {
    const row = await withTenant(this.s.db, actor.organisationId, async (tx) => {
      const refund = await tx.cashfreeRefund.findUnique({ where: { id } });
      if (!refund || !(await tx.refundEntry.findUnique({ where: { refundId: id } })))
        throw missing();
      await writeAudit(tx, request, {
        action: 'refund.voucher_viewed',
        organisationId: actor.organisationId,
        actorUserId: actor.userId,
        entityType: 'cashfree_refund',
        entityId: id,
      });
      return { refund: await this.out(tx, refund), paymentId: refund.paymentId };
    });
    return {
      refund: row.refund,
      originalReceipt: await new BillingService(this.s).receipt(request, actor, row.paymentId),
    };
  }
}
