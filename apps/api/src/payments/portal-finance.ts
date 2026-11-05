import { withTenant, type Tx, type Prisma } from '@dhc/db';
import {
  PortalBill,
  PortalBillList,
  PortalReceiptList,
  PortalFinanceQuery,
  PortalCheckoutBody,
  PortalReceipt,
  FinanceLinkTarget,
} from '@dhc/contracts';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Services } from '../services';
import { authOf, authenticate, requireRole } from '../plugins/authenticate';
import { AppError } from '../errors';
import { accountHistoryWhere, accountPhone, ownHistory } from '../modules/portal/account';
import { PortalService } from '../modules/portal/service';
import { BillingService } from '../modules/billing/service';
import { OnlinePaymentsService } from './service';
import { paymentToken } from './cashfree';
import { verifyFinanceLinkToken } from '@dhc/secure-links';
const Id = z.object({ id: z.uuid() });
interface Actor {
  organisationId: string;
  userId: string;
}
const missing = () => new AppError(404, 'NOT_FOUND', 'Payment record not found.');
export class PortalFinanceService {
  constructor(private readonly s: Services) {}
  private async access(tx: Tx, a: Actor, phone: string, id: string) {
    await new PortalService(this.s).requireConsents(tx, a);
    await ownHistory(tx, phone, id);
  }
  private output(
    bill: Prisma.BillGetPayload<{
      include: {
        onlineOrders: true;
        appointment: {
          include: { prepaidBooking: true; patient: { include: { mergedInto: true } } };
        };
      };
    }>,
    a: Actor,
    refunded: number,
  ): PortalBill {
    const p = bill.appointment.patient,
      order = bill.onlineOrders[0],
      c = this.s.cashfree,
      m = c?.merchants[a.organisationId];
    const bound =
        order && m?.clientId === order.merchantClientId && m.environment === order.environment,
      payable = !!c && c.acceptNewPayments !== false && !!m;
    const link =
      order && bound && payable && order.status === 'active' && order.expiresAt > this.s.now()
        ? new URL(
            '/pay/' + paymentToken(order.id, order.expiresAt, c!.linkSecret),
            c!.webBaseUrl,
          ).toString()
        : null;
    return PortalBill.parse({
      id: bill.id,
      appointmentId: bill.appointmentId,
      patient: p.mergedInto ?? p,
      visitDate: bill.appointment.date.toISOString().slice(0, 10),
      totalPaise: bill.totalPaise,
      paidPaise: bill.paidPaise,
      balancePaise: bill.totalPaise - bill.paidPaise,
      refundedPaise: refunded,
      netCollectedPaise: bill.paidPaise - refunded,
      prepaidBookingId: bill.appointment.prepaidBooking?.id ?? null,
      canPay:
        payable &&
        !bill.appointment.prepaidBooking &&
        bill.totalPaise - bill.paidPaise >= 100 &&
        (!order || !['closing', 'review'].includes(order.status)) &&
        (!order || bound) &&
        (!order || order.expiresAt > this.s.now()),
      order: order
        ? {
            id: order.id,
            status: order.status,
            expiresAt: order.expiresAt.toISOString(),
            paymentUrl: link,
          }
        : null,
    });
  }
  private include = {
    onlineOrders: {
      where: { status: { in: ['creating', 'active', 'closing', 'review'] } },
      orderBy: { createdAt: 'desc' as const },
      take: 1,
    },
    appointment: {
      include: {
        prepaidBooking: true as const,
        patient: { include: { mergedInto: true as const } },
      },
    },
  };
  async bill(a: Actor, id: string): Promise<PortalBill> {
    const phone = await accountPhone(this.s, a.userId);
    return withTenant(this.s.db, a.organisationId, async (tx) => {
      const bill = await tx.bill.findUnique({ where: { id }, include: this.include });
      if (!bill) throw missing();
      await this.access(tx, a, phone, bill.patientId);
      const sum = await tx.refundEntry.aggregate({
        where: { billId: id },
        _sum: { amountPaise: true },
      });
      return this.output(bill, a, sum._sum.amountPaise ?? 0);
    });
  }
  async bills(a: Actor, q: z.infer<typeof PortalFinanceQuery>) {
    const phone = await accountPhone(this.s, a.userId);
    return withTenant(this.s.db, a.organisationId, async (tx) => {
      await new PortalService(this.s).requireConsents(tx, a);
      if (q.patientId) await ownHistory(tx, phone, q.patientId);
      const where: Prisma.BillWhereInput = {
        appointment: {
          patient: {
            AND: [
              accountHistoryWhere(phone),
              ...(q.patientId
                ? [{ OR: [{ id: q.patientId }, { mergedIntoId: q.patientId }] }]
                : []),
            ],
          },
        },
      };
      if (q.cursor && !(await tx.bill.findFirst({ where: { AND: [where, { id: q.cursor }] } })))
        throw missing();
      const rows = await tx.bill.findMany({
        where,
        include: this.include,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: q.limit + 1,
        ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      });
      const page = rows.slice(0, q.limit),
        sums = await tx.refundEntry.groupBy({
          by: ['billId'],
          where: { billId: { in: page.map((b) => b.id) } },
          _sum: { amountPaise: true },
        }),
        refunds = new Map(sums.map((r) => [r.billId, r._sum.amountPaise ?? 0]));
      return {
        data: page.map((b) => this.output(b, a, refunds.get(b.id) ?? 0)),
        nextCursor: rows.length > q.limit ? page.at(-1)!.id : null,
      };
    });
  }
  async receipts(a: Actor, q: z.infer<typeof PortalFinanceQuery>) {
    const phone = await accountPhone(this.s, a.userId);
    return withTenant(this.s.db, a.organisationId, async (tx) => {
      await new PortalService(this.s).requireConsents(tx, a);
      if (q.patientId) await ownHistory(tx, phone, q.patientId);
      const where: Prisma.PaymentWhereInput = {
        bill: {
          appointment: {
            patient: {
              AND: [
                accountHistoryWhere(phone),
                ...(q.patientId
                  ? [{ OR: [{ id: q.patientId }, { mergedIntoId: q.patientId }] }]
                  : []),
              ],
            },
          },
        },
      };
      if (q.cursor && !(await tx.payment.findFirst({ where: { AND: [where, { id: q.cursor }] } })))
        throw missing();
      const rows = await tx.payment.findMany({
        where,
        include: {
          bill: {
            include: { appointment: { include: { patient: { include: { mergedInto: true } } } } },
          },
        },
        orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
        take: q.limit + 1,
        ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      });
      return {
        data: rows.slice(0, q.limit).map((r) => ({
          id: r.id,
          billId: r.billId,
          receiptNumber: r.receiptNumber,
          patientName: (r.bill.appointment.patient.mergedInto ?? r.bill.appointment.patient).name,
          amountPaise: r.amountPaise,
          mode: r.mode,
          receivedAt: r.receivedAt.toISOString(),
        })),
        nextCursor: rows.length > q.limit ? rows[q.limit - 1]!.id : null,
      };
    });
  }
  async receipt(req: FastifyRequest, a: Actor, id: string) {
    const phone = await accountPhone(this.s, a.userId);
    const original = await new BillingService(this.s).receipt(
      req,
      { ...a, role: 'patient' },
      id,
      (tx, p) => this.access(tx, a, phone, p),
    );
    const refunds = await withTenant(this.s.db, a.organisationId, async (tx) => {
      const payment = await tx.payment.findUnique({ where: { id }, include: { bill: true } });
      if (!payment) throw missing();
      await this.access(tx, a, phone, payment.bill.patientId);
      const rows = await tx.refundEntry.findMany({
        where: { paymentId: id },
        orderBy: [{ postedAt: 'asc' }, { refundId: 'asc' }],
      });
      return rows.map((r) => ({
        id: r.refundId,
        voucherNumber: r.voucherNumber,
        amountPaise: r.amountPaise,
        postedAt: r.postedAt.toISOString(),
      }));
    });
    return { ...original, refunds };
  }

  async checkout(req: FastifyRequest, a: Actor, id: string, requestId: string) {
    const phone = await accountPhone(this.s, a.userId);
    await this.bill(a, id);
    await new OnlinePaymentsService(this.s).create(req, a, id, requestId, {
      phone,
      authorize: (tx, p) => this.access(tx, a, phone, p),
    });
    return this.bill(a, id);
  }
  async check(req: FastifyRequest, a: Actor, id: string) {
    const b = await this.bill(a, id);
    if (b.order && this.s.cashfree && new Date(b.order.expiresAt) <= this.s.now()) {
      await new OnlinePaymentsService(this.s).check(req, a, b.order.id, true);
      return this.bill(a, id);
    }
    if (b.order && this.s.cashfree)
      await new OnlinePaymentsService(this.s).publicCheck(
        req,
        paymentToken(b.order.id, new Date(b.order.expiresAt), this.s.cashfree.linkSecret),
      );
    return this.bill(a, id);
  }
}
export const portalFinanceRoutes: FastifyPluginAsync<{ services: Services }> = async (
  app,
  { services: s },
) => {
  const service = new PortalFinanceService(s),
    guard = { preHandler: [authenticate(s), requireRole('patient')] };
  app.addHook('onSend', async (_r, reply, payload) => {
    reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
    return payload;
  });
  app.get('/portal/bills', guard, async (r) =>
    PortalBillList.parse(await service.bills(authOf(r), PortalFinanceQuery.parse(r.query))),
  );
  app.get('/portal/bills/:id', guard, async (r) => service.bill(authOf(r), Id.parse(r.params).id));
  app.get('/portal/receipts', guard, async (r) =>
    PortalReceiptList.parse(await service.receipts(authOf(r), PortalFinanceQuery.parse(r.query))),
  );
  app.get('/portal/receipts/:id', guard, async (r) =>
    PortalReceipt.parse(await service.receipt(r, authOf(r), Id.parse(r.params).id)),
  );
  const limited = { ...guard, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } };
  app.post('/portal/bills/:id/checkout', limited, async (r) =>
    service.checkout(r, authOf(r), Id.parse(r.params).id, PortalCheckoutBody.parse(r.body).id),
  );
  app.post('/portal/bills/:id/check', limited, async (r) =>
    service.check(r, authOf(r), Id.parse(r.params).id),
  );
  app.get('/portal/finance-links/:token', { ...guard, logLevel: 'silent' }, async (r) => {
    const token = z.object({ token: z.string().max(180) }).parse(r.params).token,
      v = s.paymentLinkSecret ? verifyFinanceLinkToken(token, s.paymentLinkSecret, s.now()) : null;
    if (!v) throw missing();
    const a = authOf(r),
      phone = await accountPhone(s, a.userId);
    const d = await withTenant(s.db, a.organisationId, async (tx) => {
      await new PortalService(s).requireConsents(tx, a);
      const row = await tx.whatsAppDelivery.findUnique({ where: { id: v.deliveryId } });
      if (
        !row?.recipientPatientId ||
        !row.attemptedAt ||
        !row.linkExpiresAt ||
        Math.floor(row.linkExpiresAt.getTime() / 1000) !== v.expiresAt
      )
        throw missing();
      await ownHistory(tx, phone, row.recipientPatientId);
      return row;
    });
    if (d.kind === 'payment_link' && d.financialOrderId) {
      const order = await withTenant(s.db, a.organisationId, (tx) =>
        tx.cashfreeOrder.findUnique({ where: { id: d.financialOrderId! } }),
      );
      if (!order) throw missing();
      const b = await service.bill(a, order.billId);
      if (b.order?.id !== order.id || !b.order.paymentUrl) throw missing();
      return FinanceLinkTarget.parse({
        kind: d.kind,
        sourceId: b.id,
        paymentUrl: b.order.paymentUrl,
      });
    }
    const id =
      d.kind === 'receipt_ready'
        ? d.receiptPaymentId
        : d.kind === 'refund_ready' && d.refundEntryId
          ? (
              await withTenant(s.db, a.organisationId, (tx) =>
                tx.refundEntry.findUnique({ where: { refundId: d.refundEntryId! } }),
              )
            )?.paymentId
          : null;
    if (!id) throw missing();
    await service.receipt(r, a, id);
    return FinanceLinkTarget.parse({ kind: d.kind, sourceId: id, paymentUrl: null });
  });
};
