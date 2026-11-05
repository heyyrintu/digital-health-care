import { settleBooking } from './prepaid-state';
import { withAuth, withPayments, withTenant, type Prisma, type Tx } from '@dhc/db';
import { billStatus, formatReceiptNumber } from '@dhc/domain';
import { randomUUID, createHash } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../errors';
import type { Services } from '../services';
import { writeAudit } from '../modules/audit/write';
import {
  CashfreeUnavailable,
  paymentToken,
  paymentTokenId,
  toPaise,
  type CashfreeWebhook,
  type Merchant,
  type ProviderOrder,
  type ProviderPayment,
} from './cashfree';

type Order = Prisma.CashfreeOrderGetPayload<object>;
interface Actor {
  organisationId: string;
  userId: string;
}
const OPEN = ['creating', 'active', 'closing', 'review'];
const missing = () => new AppError(404, 'NOT_FOUND', 'Payment not found.');
const conflict = (message: string) => new AppError(409, 'CONFLICT', message);
export class OnlinePaymentsService {
  constructor(private readonly s: Services) {}
  private integration() {
    if (!this.s.cashfree)
      throw new AppError(503, 'BUSINESS_RULE', 'Online payments are not enabled yet.');
    return this.s.cashfree;
  }
  private merchant(row: Order): Merchant {
    const m = this.integration().merchants[row.organisationId];
    if (!m || m.clientId !== row.merchantClientId || m.environment !== row.environment)
      throw conflict(
        'The original clinic payment account must be configured to check this payment.',
      );
    return m;
  }
  private async out(tx: Tx, row: Order) {
    const receipt = await tx.payment.findUnique({
      where: { cashfreeOrderId: row.id },
      select: { id: true },
    });
    const reviewRequired = !!(await tx.cashfreeEvent.findFirst({
      where: { orderId: row.id, outcome: 'review' },
    }));
    const config = this.s.cashfree;
    return {
      reviewRequired,
      id: row.id,
      amountPaise: row.amountPaise,
      status: row.status,
      expiresAt: row.expiresAt.toISOString(),
      paymentUrl: config
        ? new URL(
            '/pay/' + paymentToken(row.id, row.expiresAt, config.linkSecret),
            config.webBaseUrl,
          ).toString()
        : null,
      paymentId: receipt?.id ?? null,
    };
  }
  async view(actor: Actor, billId: string) {
    return withTenant(this.s.db, actor.organisationId, async (tx) => {
      if (!(await tx.bill.findUnique({ where: { id: billId } }))) throw missing();
      const order =
        (await tx.cashfreeOrder.findFirst({
          where: { billId, status: { in: OPEN } },
          orderBy: { createdAt: 'desc' },
        })) ??
        (await tx.cashfreeOrder.findFirst({
          where: { billId },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        }));
      return {
        acceptingPayments: this.s.cashfree?.acceptNewPayments !== false,
        available: !!this.s.cashfree?.merchants[actor.organisationId],
        order: order ? await this.out(tx, order) : null,
      };
    });
  }
  async create(
    request: FastifyRequest,
    actor: Actor,
    billId: string,
    id: string,
    patientAccess?: { phone: string; authorize: (tx: Tx, patientId: string) => Promise<unknown> },
  ) {
    const config = this.integration(),
      merchant = config.merchants[actor.organisationId];
    if (config.acceptNewPayments === false) throw conflict('New online payments are paused.');
    if (!merchant) throw conflict('This clinic has not connected its payment account.');
    const row = await withPayments(this.s.db, actor.organisationId, (tx) =>
      this.reserve(tx, request, actor, billId, id, patientAccess?.phone, patientAccess?.authorize),
    );
    await this.ensure(request, row);
    return this.view(actor, billId);
  }
  /** Reserves the immutable order in the booking transaction, before any network call. */
  async reserve(
    tx: Tx,
    request: FastifyRequest,
    actor: Actor,
    billId: string,
    id: string,
    phoneOverride?: string,
    authorize?: (tx: Tx, patientId: string) => Promise<unknown>,
  ) {
    id = id.toLowerCase();
    const config = this.integration(),
      merchant = config.merchants[actor.organisationId];
    if (config.acceptNewPayments === false || !merchant)
      throw conflict('New online payments are unavailable.');
    await tx.$queryRaw`SELECT id FROM bills WHERE id = ${billId}::uuid FOR UPDATE`;
    const bill = await tx.bill.findUnique({ where: { id: billId } });
    if (!bill) throw missing();
    await authorize?.(tx, bill.patientId);
    const prior = await tx.cashfreeOrder.findUnique({ where: { id } });
    if (prior) {
      if (prior.billId !== billId) throw conflict('This payment request is already used.');
      return prior;
    }
    const reservation = await tx.cashfreeBooking.findFirst({
      where: { appointment: { bill: { id: billId } } },
    });
    if (reservation) throw conflict('Use the original booking payment.');
    const open = await tx.cashfreeOrder.findFirst({ where: { billId, status: { in: OPEN } } });
    if (open) return open;
    const amountPaise = bill.totalPaise - bill.paidPaise;
    if (amountPaise < 100)
      throw conflict('Online payments require an unpaid balance of at least ₹1.');
    const patient = await tx.patient.findUnique({
      where: { id: bill.patientId },
      include: { mergedInto: true },
    });
    const phone = phoneOverride ?? (patient?.mergedInto ?? patient)?.phone;
    if (!phone || !/^\+91\d{10}$/.test(phone))
      throw conflict('Add a recipient mobile number before creating an online payment.');
    const expiresAt = new Date(this.s.now().getTime() + 30 * 60_000);
    const returnUrl = new URL(
      '/pay/' + paymentToken(id, expiresAt, config.linkSecret),
      config.webBaseUrl,
    ).toString();
    const order = await tx.cashfreeOrder.create({
      data: {
        id,
        organisationId: actor.organisationId,
        billId,
        providerOrderId: 'dhc_' + id.replaceAll('-', ''),
        merchantClientId: merchant.clientId,
        environment: merchant.environment,
        amountPaise,
        expiresAt,
        createdByUserId: actor.userId,
        requestCipher: this.s.cipher.encrypt(
          JSON.stringify({ phone, returnUrl, notifyUrl: config.notifyUrl }),
        ),
      },
    });
    await writeAudit(tx, request, {
      action: 'payment.online_created',
      organisationId: actor.organisationId,
      actorUserId: actor.userId,
      entityType: 'cashfree_order',
      entityId: id,
      metadata: { billId, amountPaise, environment: merchant.environment },
    });
    return order;
  }
  async ensureBooking(request: FastifyRequest, organisationId: string, id: string) {
    const row = await this.mappedOrder(organisationId, id);
    await this.ensure(request, row);
  }
  private async ensure(request: FastifyRequest, row: Order) {
    if (row.status !== 'creating') return;
    const config = this.integration(),
      merchant = this.merchant(row);
    try {
      let remote = await config.gateway.order(merchant, row.providerOrderId);
      if (!remote) {
        if (config.acceptNewPayments === false) throw conflict('New online payments are paused.');
        if (row.expiresAt <= this.s.now())
          throw conflict('Check or close this payment before creating a new one.');
        const details = JSON.parse(this.s.cipher.decrypt(row.requestCipher)) as {
          phone: string;
          returnUrl: string;
          notifyUrl: string;
        };
        remote = await config.gateway.create(merchant, {
          ...details,
          id: row.id,
          providerOrderId: row.providerOrderId,
          amountPaise: row.amountPaise,
          expiresAt: row.expiresAt,
        });
      }
      await this.acceptSnapshot(request, row, remote);
    } catch (e) {
      this.providerError(e);
    }
  }
  private providerError(e: unknown): never {
    if (e instanceof AppError) throw e;
    throw new AppError(503, 'BUSINESS_RULE', new CashfreeUnavailable().message);
  }
  async lookup(providerId: string) {
    const [row] = await withAuth(
      this.s.db,
      (tx) =>
        tx.$queryRaw<
          { id: string; organisation_id: string }[]
        >`SELECT * FROM auth_cashfree_order(${providerId})`,
    );
    return row ?? null;
  }
  async publicOrder(token: string) {
    const config = this.integration(),
      id = paymentTokenId(token, config.linkSecret);
    if (!id) throw missing();
    const route = await this.lookup('dhc_' + id.replaceAll('-', ''));
    if (!route) throw missing();
    return withTenant(this.s.db, route.organisation_id, async (tx) => {
      const row = await tx.cashfreeOrder.findUnique({ where: { id } });
      if (
        !row ||
        paymentToken(id, row.expiresAt, config.linkSecret) !== token ||
        this.s.now().getTime() > row.expiresAt.getTime() + 86400_000
      )
        throw missing();
      const org = await tx.organisation.findUnique({
        where: { id: row.organisationId },
        include: { branding: true },
      });
      if (!org || org.status !== 'active') throw missing();
      return {
        row,
        public: {
          canPay:
            config.acceptNewPayments !== false &&
            row.status === 'active' &&
            row.expiresAt > this.s.now(),
          clinicName: org.branding?.displayName ?? org.name,
          amountPaise: row.amountPaise,
          currency: 'INR' as const,
          status: row.status,
          expiresAt: row.expiresAt.toISOString(),
        },
      };
    });
  }
  async checkout(request: FastifyRequest, token: string) {
    if (this.integration().acceptNewPayments === false)
      throw conflict('New online payments are paused.');
    let { row } = await this.publicOrder(token);
    if (row.expiresAt <= this.s.now() || !['creating', 'active'].includes(row.status))
      throw conflict('This payment link is no longer available for payment.');
    await this.ensure(request, row);
    row = (await this.publicOrder(token)).row;
    if (row.status !== 'active' || !row.sessionCipher)
      throw conflict('Check the payment status before continuing.');
    this.merchant(row);
    return {
      paymentSessionId: this.s.cipher.decrypt(row.sessionCipher),
      environment: row.environment,
    };
  }
  async check(request: FastifyRequest, actor: Actor, id: string, close = false) {
    const row = await withTenant(this.s.db, actor.organisationId, (tx) =>
      tx.cashfreeOrder.findUnique({ where: { id } }),
    );
    if (!row) throw missing();
    await this.refresh(request, row, close);
    return this.view(actor, row.billId);
  }
  async publicCheck(request: FastifyRequest, token: string) {
    const current = await this.publicOrder(token),
      { row } = current;
    if (row.status === 'paid') return current.public;
    if (!row.checkedAt || this.s.now().getTime() - row.checkedAt.getTime() >= 5000) {
      const leased = await withPayments(this.s.db, row.organisationId, async (tx) => {
        // Match creation/callback lock order: bill first, then its order row.
        await tx.$queryRaw`SELECT id FROM bills WHERE id = ${row.billId}::uuid FOR UPDATE`;
        return tx.cashfreeOrder.updateMany({
          where: {
            id: row.id,
            OR: [
              { checkedAt: null },
              { checkedAt: { lte: new Date(this.s.now().getTime() - 5000) } },
            ],
          },
          data: { checkedAt: this.s.now() },
        });
      });
      if (leased.count) await this.refresh(request, row);
    }
    return (await this.publicOrder(token)).public;
  }
  private async refresh(request: FastifyRequest, row: Order, close = false) {
    const config = this.integration(),
      merchant = this.merchant(row);
    if (row.status === 'paid') return;
    try {
      let remote = await config.gateway.order(merchant, row.providerOrderId);
      if (close && remote && ['ACTIVE', 'TERMINATION_REQUESTED'].includes(remote.order_status)) {
        await config.gateway.terminate(merchant, row.providerOrderId);
        remote = await config.gateway.order(merchant, row.providerOrderId);
      }
      if (!remote)
        throw conflict(
          'The provider has not confirmed this order. Retry the original creation request; do not collect again.',
        );
      await this.acceptSnapshot(request, row, remote);
    } catch (e) {
      this.providerError(e);
    }
  }
  private matches(
    row: Order,
    remote: { order_id: string; order_amount: number | string; order_currency: string },
  ) {
    try {
      return (
        remote.order_id === row.providerOrderId &&
        remote.order_currency === row.currency &&
        toPaise(remote.order_amount) === row.amountPaise
      );
    } catch {
      return false;
    }
  }
  private async acceptSnapshot(request: FastifyRequest, row: Order, remote: ProviderOrder) {
    if (!this.matches(row, remote)) {
      await this.apply(request, row, null, 'review');
      return;
    }
    if (remote.order_status === 'PAID' || ['EXPIRED', 'TERMINATED'].includes(remote.order_status)) {
      const payments = await this.integration().gateway.payments(
        this.merchant(row),
        row.providerOrderId,
      );
      const success = payments.filter((p) => p.payment_status === 'SUCCESS');
      if (success.length === 1 && success[0]!.is_captured !== false) {
        await this.apply(request, row, success[0]!, 'paid');
        return;
      }
      if (
        success.length ||
        remote.order_status === 'PAID' ||
        payments.some((p) => p.payment_status === 'PENDING')
      ) {
        await this.apply(request, row, null, 'review');
        return;
      }
      await this.apply(
        request,
        row,
        null,
        remote.order_status.toLowerCase() as 'expired' | 'terminated',
      );
      return;
    }
    await withPayments(this.s.db, row.organisationId, async (tx) => {
      await tx.$queryRaw`SELECT id FROM bills WHERE id = ${row.billId}::uuid FOR UPDATE`;
      await tx.cashfreeOrder.updateMany({
        where: { id: row.id, status: { in: ['creating', 'active', 'closing'] } },
        data: {
          status: remote.order_status === 'TERMINATION_REQUESTED' ? 'closing' : 'active',
          checkedAt: this.s.now(),
          ...(remote.payment_session_id
            ? { sessionCipher: this.s.cipher.encrypt(remote.payment_session_id) }
            : {}),
        },
      });
    });
  }
  async webhook(request: FastifyRequest, row: Order, event: CashfreeWebhook, raw: Buffer) {
    const match = this.matches(row, event.data.order);
    const success =
      event.type === 'PAYMENT_SUCCESS_WEBHOOK' && event.data.payment.payment_status === 'SUCCESS';
    return this.apply(
      request,
      row,
      success && match ? { ...event.data.payment, order_id: event.data.order.order_id } : null,
      !match || (event.type === 'PAYMENT_SUCCESS_WEBHOOK' && !success)
        ? 'review'
        : success
          ? 'paid'
          : 'ignored',
      {
        paymentId: event.data.payment.cf_payment_id,
        amount: event.data.payment.payment_amount,
        currency: event.data.payment.payment_currency,
        kind: event.type,
        hash: createHash('sha256').update(raw).digest('hex'),
      },
    );
  }
  async mappedOrder(organisationId: string, id: string) {
    const row = await withTenant(this.s.db, organisationId, (tx) =>
      tx.cashfreeOrder.findUnique({ where: { id } }),
    );
    if (!row) throw missing();
    this.merchant(row);
    return row;
  }
  private async apply(
    request: FastifyRequest,
    initial: Order,
    payment: ProviderPayment | null,
    outcome: 'paid' | 'expired' | 'terminated' | 'review' | 'ignored',
    event?: {
      kind: string;
      hash: string;
      paymentId: string;
      amount: number | string;
      currency: string;
    },
  ) {
    await withPayments(this.s.db, initial.organisationId, async (tx) => {
      await tx.$queryRaw`SELECT id FROM bills WHERE id = ${initial.billId}::uuid FOR UPDATE`;
      const row = await tx.cashfreeOrder.findUniqueOrThrow({ where: { id: initial.id } }),
        bill = await tx.bill.findUniqueOrThrow({ where: { id: row.billId } });
      if (
        event &&
        (await tx.cashfreeEvent.findUnique({
          where: {
            organisationId_eventHash: { organisationId: row.organisationId, eventHash: event.hash },
          },
        }))
      )
        return;
      let result: string = outcome;
      const duplicate = row.status === 'paid' && payment?.cf_payment_id === row.providerPaymentId;
      if (row.status === 'paid') result = payment && !duplicate ? 'review' : 'ignored';
      else if (outcome === 'paid') {
        let valid =
          !!payment &&
          payment.order_id === row.providerOrderId &&
          payment.payment_currency === row.currency &&
          payment.is_captured !== false;
        try {
          valid = valid && toPaise(payment!.payment_amount) === row.amountPaise;
        } catch {
          valid = false;
        }
        const used = payment
          ? await tx.cashfreeOrder.findFirst({
              where: {
                merchantClientId: row.merchantClientId,
                environment: row.environment,
                providerPaymentId: payment.cf_payment_id,
                id: { not: row.id },
              },
            })
          : null;
        if (!valid || used || bill.totalPaise - bill.paidPaise < row.amountPaise) result = 'review';
        else {
          // Another link must be checked/closed if a late successful transaction arrives.
          await tx.cashfreeOrder.updateMany({
            where: { billId: row.billId, id: { not: row.id }, status: { in: OPEN } },
            data: { status: 'review' },
          });
          await tx.cashfreeOrder.update({
            where: { id: row.id },
            data: {
              status: 'paid',
              providerPaymentId: payment!.cf_payment_id,
              checkedAt: this.s.now(),
            },
          });
          const [counter] = await tx.$queryRaw<
            { prefix: string; n: number }[]
          >`INSERT INTO receipt_settings(organisation_id,next_number,updated_at) VALUES(${row.organisationId}::uuid,2,now()) ON CONFLICT(organisation_id) DO UPDATE SET next_number=receipt_settings.next_number+1,updated_at=now() RETURNING prefix,next_number-1 AS n`;
          await tx.payment.create({
            data: {
              id: randomUUID(),
              organisationId: row.organisationId,
              billId: row.billId,
              cashfreeOrderId: row.id,
              mode: 'cashfree',
              amountPaise: row.amountPaise,
              reference: payment!.cf_payment_id,
              receiptNumber: formatReceiptNumber(counter!.prefix, Number(counter!.n)),
              receivedByUserId: row.createdByUserId,
              receivedAt: this.s.now(),
            },
          });
          const paid = bill.paidPaise + row.amountPaise;
          await tx.bill.update({
            where: { id: bill.id },
            data: {
              paidPaise: paid,
              status: billStatus(bill.totalPaise, paid),
              revision: { increment: 1 },
            },
          });
        }
      } else if (row.status !== 'paid' && ['expired', 'terminated'].includes(outcome)) {
        await tx.cashfreeOrder.update({
          where: { id: row.id },
          data: { status: outcome, checkedAt: this.s.now() },
        });
      }
      if (result === 'review' && row.status !== 'paid') {
        const other = await tx.cashfreeOrder.findFirst({
          where: { billId: row.billId, id: { not: row.id }, status: { in: OPEN } },
        });
        await tx.cashfreeOrder.update({
          where: { id: other?.id ?? row.id },
          data: { status: 'review', checkedAt: this.s.now() },
        });
      }
      await settleBooking(tx, request, row.id, this.s.now());
      let eventAmount: number | null = null;
      if (event) {
        try {
          eventAmount = toPaise(event.amount);
        } catch {
          /* Retain no malformed amount. */
        }
      }
      if (event)
        await tx.cashfreeEvent.create({
          data: {
            providerPaymentId: event.paymentId,
            amountPaise: eventAmount,
            currency: event.currency,
            organisationId: row.organisationId,
            orderId: row.id,
            eventHash: event.hash,
            kind: event.kind,
            outcome: result,
          },
        });
      await writeAudit(tx, request, {
        action:
          result === 'review'
            ? 'payment.online_review'
            : result === 'paid'
              ? 'payment.online_confirmed'
              : 'payment.online_checked',
        organisationId: row.organisationId,
        entityType: 'cashfree_order',
        entityId: row.id,
        metadata: { billId: bill.id, outcome: result },
      });
    });
  }
}
