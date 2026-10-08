import type {
  AppointmentStatus,
  Bill,
  BillView,
  CollectionsReport,
  CreatePriceListItemBody,
  Payment,
  PriceListItem,
  Receipt,
  RecordPaymentBody,
  Role,
  SaveBillBody,
  UpdatePriceListItemBody,
} from '@dhc/contracts';
import { Prisma, withAuth, withTenant, type Tx } from '@dhc/db';
import {
  BillTooLargeError,
  billStatus,
  billTotals,
  formatReceiptNumber,
  istDateKey,
} from '@dhc/domain';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../../errors';
import type { Services } from '../../services';
import { writeAudit } from '../audit/write';
import { lockVisit } from '../clinical/service';

interface Actor {
  userId: string;
  organisationId: string;
  role: Role;
}

/** Visits that can be billed: the patient has arrived. Prepaid booking arrives with Cashfree. */
export const BILLABLE_STATUSES: AppointmentStatus[] = [
  'checked_in',
  'in_consultation',
  'completed',
];
/** Who makes bills and takes counter payments (PRD §3.2); clinic admins view. */
const BILLERS: Role[] = ['front_desk', 'doctor'];

const NOT_FOUND = () => new AppError(404, 'NOT_FOUND', 'Not found.');
const invalid = (field: string, message: string) =>
  new AppError(400, 'VALIDATION_FAILED', message, { [field]: 'invalid' });
const fromDbDate = (date: Date) => date.toISOString().slice(0, 10);

const billInclude = {
  items: { orderBy: { sortOrder: 'asc' } },
  payments: { orderBy: [{ receivedAt: 'asc' }, { receiptNumber: 'asc' }] },
} satisfies Prisma.BillInclude;
type BillRow = Prisma.BillGetPayload<{ include: typeof billInclude }>;
type PaymentRow = Prisma.PaymentGetPayload<object>;
type PriceRow = Prisma.PriceListItemGetPayload<object>;

const priceOut = (row: PriceRow): PriceListItem => ({
  id: row.id,
  name: row.name,
  pricePaise: row.pricePaise,
  active: row.active,
});

/**
 * Billing and counter payments (PRD §5.6, Phase 1): the clinic's price list, one bill per
 * visit priced by the server, and cash, UPI and card payments with numbered receipts.
 * Online payments, links and refunds come with Cashfree (Phase 3).
 */
export class BillingService {
  constructor(private readonly s: Services) {}

  // ---- Price list --------------------------------------------------------------------

  async priceList(actor: Actor): Promise<PriceListItem[]> {
    const rows = await withTenant(this.s.db, actor.organisationId, (tx) =>
      tx.priceListItem.findMany({ orderBy: [{ active: 'desc' }, { name: 'asc' }] }),
    );
    return rows.map(priceOut);
  }

  async createPriceListItem(
    request: FastifyRequest,
    actor: Actor,
    body: CreatePriceListItemBody,
  ): Promise<PriceListItem> {
    return withTenant(this.s.db, actor.organisationId, async (tx) => {
      const row = await this.uniqueName(() =>
        tx.priceListItem.create({ data: { organisationId: actor.organisationId, ...body } }),
      );
      await this.audit(tx, request, actor, 'price_list.created', 'price_list_item', row.id, {
        pricePaise: row.pricePaise,
      });
      return priceOut(row);
    });
  }

  async updatePriceListItem(
    request: FastifyRequest,
    actor: Actor,
    id: string,
    body: UpdatePriceListItemBody,
  ): Promise<PriceListItem> {
    return withTenant(this.s.db, actor.organisationId, async (tx) => {
      const existing = await tx.priceListItem.findUnique({ where: { id } });
      if (!existing) throw NOT_FOUND();
      const row = await this.uniqueName(() =>
        tx.priceListItem.update({ where: { id }, data: body }),
      );
      await this.audit(tx, request, actor, 'price_list.updated', 'price_list_item', id, {
        fields: Object.keys(body),
        ...(body.pricePaise !== undefined ? { pricePaise: body.pricePaise } : {}),
      });
      return priceOut(row);
    });
  }

  // ---- Bills -------------------------------------------------------------------------

  async view(actor: Actor, appointmentId: string): Promise<BillView> {
    const { appointment, bill } = await withTenant(this.s.db, actor.organisationId, async (tx) => {
      const appointment = await tx.appointment.findUnique({
        where: { id: appointmentId },
        include: { consultationType: true },
      });
      if (!appointment) throw NOT_FOUND();
      const bill = await tx.bill.findUnique({ where: { appointmentId }, include: billInclude });
      return { appointment, bill };
    });
    const biller = BILLERS.includes(actor.role);
    const billable = BILLABLE_STATUSES.includes(appointment.status);
    return {
      bill: bill ? await this.billOut(bill) : null,
      consultationTypeName: appointment.consultationType.name,
      feePaise: appointment.consultationType.feePaise,
      followUpFeePaise: appointment.consultationType.followUpFeePaise,
      canEdit: biller && billable && (bill?.paidPaise ?? 0) === 0,
      canPay: biller && !!bill && bill.paidPaise < bill.totalPaise,
    };
  }

  /**
   * Creates or replaces the visit's bill. Every line is priced here, from the visit's
   * consultation type and the price list; the client sends only what to charge.
   */
  async save(
    request: FastifyRequest,
    actor: Actor,
    appointmentId: string,
    body: SaveBillBody,
  ): Promise<Bill> {
    const ids = body.items.map((i) => i.priceListItemId);
    if (new Set(ids).size !== ids.length) {
      throw invalid('items', 'Add each item once and set its quantity.');
    }

    const row = await withTenant(this.s.db, actor.organisationId, async (tx) => {
      const appointment = await lockVisit(tx, appointmentId);
      if (!BILLABLE_STATUSES.includes(appointment.status)) {
        throw new AppError(409, 'CONFLICT', 'A visit can be billed once the patient has arrived.');
      }
      // Takes turns with payments on this bill, so a payment recorded meanwhile is seen.
      await tx.$queryRaw`SELECT id FROM bills WHERE appointment_id = ${appointmentId}::uuid FOR UPDATE`;
      const existing = await tx.bill.findUnique({ where: { appointmentId } });
      if (existing && existing.paidPaise > 0) {
        throw new AppError(409, 'CONFLICT', 'This bill has a payment and can no longer change.');
      }
      if ((existing?.revision ?? 0) !== body.revision) {
        throw new AppError(
          409,
          'CONFLICT',
          'This bill was changed somewhere else. Reload to see the latest version.',
          { revision: 'stale' },
        );
      }

      const saved = existing ? await tx.billItem.findMany({ where: { billId: existing.id } }) : [];
      const lines = await this.price(tx, appointment.consultationTypeId, body, saved);
      let totals;
      try {
        totals = billTotals(lines, body.discountPaise);
      } catch (e) {
        if (e instanceof BillTooLargeError) throw invalid('items', e.message);
        throw invalid('discountPaise', 'The discount cannot be more than the bill.');
      }
      const figures = {
        subtotalPaise: totals.subtotal,
        discountPaise: totals.discount,
        discountReason: totals.discount > 0 ? body.discountReason : null,
        totalPaise: totals.total,
        status: billStatus(totals.total, 0),
      };
      const bill = existing
        ? await tx.bill.update({
            where: { id: existing.id },
            data: { ...figures, revision: existing.revision + 1 },
          })
        : await tx.bill.create({
            data: {
              ...figures,
              organisationId: actor.organisationId,
              appointmentId,
              patientId: appointment.patientId,
              doctorUserId: appointment.doctorUserId,
              createdByUserId: actor.userId,
            },
          });
      await tx.billItem.deleteMany({ where: { billId: bill.id } });
      await tx.billItem.createMany({
        data: lines.map((line, sortOrder) => ({
          ...line,
          amountPaise: line.unitPaise * line.quantity,
          organisationId: actor.organisationId,
          billId: bill.id,
          sortOrder,
        })),
      });
      await this.audit(tx, request, actor, 'bill.saved', 'bill', bill.id, {
        appointmentId,
        revision: bill.revision,
        lines: lines.length,
        totalPaise: bill.totalPaise,
        discountPaise: bill.discountPaise,
      });
      return tx.bill.findUniqueOrThrow({ where: { id: bill.id }, include: billInclude });
    });
    return this.billOut(row);
  }

  /**
   * Records a counter payment and gives it the next receipt number. Repeating a payment
   * ID (a retried request) returns the payment already recorded; it is never taken twice.
   */
  async recordPayment(
    request: FastifyRequest,
    actor: Actor,
    billId: string,
    body: RecordPaymentBody,
  ): Promise<{ payment: Payment; created: boolean }> {
    const { row, created } = await withTenant(this.s.db, actor.organisationId, async (tx) => {
      await tx.$queryRaw`SELECT id FROM bills WHERE id = ${billId}::uuid FOR UPDATE`;
      const bill = await tx.bill.findUnique({ where: { id: billId } });
      if (!bill) throw NOT_FOUND();

      const earlier = await tx.payment.findUnique({ where: { id: body.id } });
      if (earlier) {
        const same =
          earlier.billId === billId &&
          earlier.mode === body.mode &&
          earlier.amountPaise === body.amountPaise;
        if (!same) {
          throw new AppError(
            409,
            'CONFLICT',
            'This payment ID is already used for another payment.',
          );
        }
        return { row: earlier, created: false };
      }

      const balance = bill.totalPaise - bill.paidPaise;
      if (balance <= 0) throw new AppError(409, 'CONFLICT', 'This bill is already paid.');
      if (body.amountPaise > balance) {
        throw invalid('amountPaise', 'The amount is more than what is due on this bill.');
      }

      const receiptNumber = await this.nextReceiptNumber(tx, actor.organisationId);
      let row: PaymentRow;
      try {
        row = await tx.payment.create({
          data: {
            id: body.id,
            organisationId: actor.organisationId,
            billId,
            mode: body.mode,
            amountPaise: body.amountPaise,
            reference: body.mode === 'cash' ? null : body.reference,
            receiptNumber,
            receivedByUserId: actor.userId,
            receivedAt: this.s.now(),
          },
        });
      } catch (error) {
        // Another clinic's payment has this ID (row-level security hides it).
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          throw new AppError(
            409,
            'CONFLICT',
            'This payment ID is already used for another payment.',
          );
        }
        throw error;
      }
      const paid = bill.paidPaise + body.amountPaise;
      await tx.bill.update({
        where: { id: billId },
        data: {
          paidPaise: paid,
          status: billStatus(bill.totalPaise, paid),
          revision: bill.revision + 1,
        },
      });
      await this.audit(tx, request, actor, 'payment.recorded', 'payment', row.id, {
        billId,
        mode: row.mode,
        amountPaise: row.amountPaise,
        receiptNumber,
      });
      return { row, created: true };
    });
    const names = await this.names([row.receivedByUserId]);
    return { payment: this.paymentOut(row, names), created };
  }

  async receipt(request: FastifyRequest, actor: Actor, paymentId: string): Promise<Receipt> {
    const { payment, bill, organisation } = await withTenant(
      this.s.db,
      actor.organisationId,
      async (tx) => {
        const payment = await tx.payment.findUnique({ where: { id: paymentId } });
        if (!payment) throw NOT_FOUND();
        const bill = await tx.bill.findUniqueOrThrow({
          where: { id: payment.billId },
          include: {
            ...billInclude,
            appointment: { include: { patient: { select: { name: true, uhid: true } } } },
          },
        });
        const organisation = await tx.organisation.findUniqueOrThrow({
          where: { id: actor.organisationId },
          select: { name: true },
        });
        await this.audit(tx, request, actor, 'receipt.viewed', 'payment', paymentId, {
          receiptNumber: payment.receiptNumber,
        });
        return { payment, bill, organisation };
      },
    );
    const names = await this.names([payment.receivedByUserId, bill.doctorUserId]);
    // Payments are ordered by time; this receipt counts itself and the ones before it.
    const upTo = bill.payments.findIndex((p) => p.id === payment.id);
    const paidToDate = bill.payments.slice(0, upTo + 1).reduce((sum, p) => sum + p.amountPaise, 0);
    return {
      payment: this.paymentOut(payment, names),
      appointmentId: bill.appointmentId,
      organisationName: organisation.name,
      patient: bill.appointment.patient,
      doctorName: names.get(bill.doctorUserId) ?? null,
      visitDate: fromDbDate(bill.appointment.date),
      lines: bill.items.map(this.lineOut),
      subtotalPaise: bill.subtotalPaise,
      discountPaise: bill.discountPaise,
      totalPaise: bill.totalPaise,
      paidToDatePaise: paidToDate,
      balanceAfterPaise: bill.totalPaise - paidToDate,
    };
  }

  // ---- Collections -------------------------------------------------------------------

  /** One IST day's counter payments by mode and doctor, and that day's visits still due. */
  async collections(actor: Actor, date?: string): Promise<CollectionsReport> {
    const day = date ?? istDateKey(this.s.now());
    // IST is UTC+05:30 all year.
    const from = new Date(`${day}T00:00:00.000+05:30`);
    const to = new Date(from.getTime() + 24 * 60 * 60 * 1000);
    const { payments, dues } = await withTenant(this.s.db, actor.organisationId, async (tx) => ({
      payments: await tx.payment.findMany({
        where: { receivedAt: { gte: from, lt: to } },
        include: {
          bill: {
            select: {
              appointmentId: true,
              doctorUserId: true,
              appointment: { select: { patient: { select: { name: true, uhid: true } } } },
            },
          },
        },
        orderBy: { receivedAt: 'asc' },
      }),
      dues: await tx.bill.findMany({
        where: {
          status: { not: 'paid' },
          appointment: { date: new Date(`${day}T00:00:00.000Z`) },
        },
        include: { appointment: { select: { patient: { select: { name: true, uhid: true } } } } },
        orderBy: { createdAt: 'asc' },
      }),
    }));
    const names = await this.names([
      ...payments.flatMap((p) => [p.receivedByUserId, p.bill.doctorUserId]),
      ...dues.map((d) => d.doctorUserId),
    ]);

    const byMode = new Map<Payment['mode'], { count: number; amountPaise: number }>();
    const byDoctor = new Map<string, { count: number; amountPaise: number }>();
    for (const p of payments) {
      const mode = byMode.get(p.mode) ?? { count: 0, amountPaise: 0 };
      byMode.set(p.mode, { count: mode.count + 1, amountPaise: mode.amountPaise + p.amountPaise });
      const doctor = byDoctor.get(p.bill.doctorUserId) ?? { count: 0, amountPaise: 0 };
      byDoctor.set(p.bill.doctorUserId, {
        count: doctor.count + 1,
        amountPaise: doctor.amountPaise + p.amountPaise,
      });
    }
    return {
      date: day,
      totalPaise: payments.reduce((sum, p) => sum + p.amountPaise, 0),
      byMode: (['cash', 'upi', 'card'] as const).map((mode) => ({
        mode,
        ...(byMode.get(mode) ?? { count: 0, amountPaise: 0 }),
      })),
      byDoctor: [...byDoctor].map(([doctorUserId, totals]) => ({
        doctorUserId,
        doctorName: names.get(doctorUserId) ?? null,
        ...totals,
      })),
      payments: payments.map((p) => ({
        ...this.paymentOut(p, names),
        appointmentId: p.bill.appointmentId,
        patientName: p.bill.appointment.patient.name,
        uhid: p.bill.appointment.patient.uhid,
        doctorName: names.get(p.bill.doctorUserId) ?? null,
      })),
      dues: dues.map((d) => ({
        billId: d.id,
        appointmentId: d.appointmentId,
        patientName: d.appointment.patient.name,
        uhid: d.appointment.patient.uhid,
        doctorName: names.get(d.doctorUserId) ?? null,
        balancePaise: d.totalPaise - d.paidPaise,
      })),
    };
  }

  // ---- Internals ---------------------------------------------------------------------

  /** The bill's lines, priced from the consultation type and the price list. */
  /**
   * Prices a bill's lines. A line already on the bill keeps the name and price it was billed
   * with; a new line takes today's fee or price-list price.
   */
  private async price(
    tx: Tx,
    consultationTypeId: string,
    body: SaveBillBody,
    saved: { kind: string; priceListItemId: string | null; name: string; unitPaise: number }[],
  ) {
    const lines: {
      kind: 'consultation' | 'follow_up' | 'item';
      priceListItemId: string | null;
      name: string;
      unitPaise: number;
      quantity: number;
    }[] = [];
    const savedFee = saved.find((l) => l.kind === body.consultation);
    if (savedFee) {
      lines.push({
        kind: body.consultation as 'consultation' | 'follow_up',
        priceListItemId: null,
        name: savedFee.name,
        unitPaise: savedFee.unitPaise,
        quantity: 1,
      });
    } else if (body.consultation !== 'none') {
      const type = await tx.consultationType.findUniqueOrThrow({
        where: { id: consultationTypeId },
      });
      const fee = body.consultation === 'follow_up' ? type.followUpFeePaise : type.feePaise;
      if (fee === null)
        throw invalid('consultation', 'This consultation type has no follow-up fee.');
      lines.push({
        kind: body.consultation,
        priceListItemId: null,
        name: type.name,
        unitPaise: fee,
        quantity: 1,
      });
    }
    const savedItems = new Map(
      saved.filter((l) => l.priceListItemId).map((l) => [l.priceListItemId!, l]),
    );
    const added = body.items.filter((i) => !savedItems.has(i.priceListItemId));
    const found = added.length
      ? await tx.priceListItem.findMany({
          where: { id: { in: added.map((i) => i.priceListItemId) }, active: true },
        })
      : [];
    const byId = new Map(found.map((p) => [p.id, { name: p.name, unitPaise: p.pricePaise }]));
    for (const item of body.items) {
      const priced = savedItems.get(item.priceListItemId) ?? byId.get(item.priceListItemId);
      if (!priced) throw invalid('items', 'An item is not on the price list.');
      lines.push({
        kind: 'item',
        priceListItemId: item.priceListItemId,
        name: priced.name,
        unitPaise: priced.unitPaise,
        quantity: item.quantity,
      });
    }
    return lines;
  }

  /** The organisation's next receipt number, taken under the counter row's lock. */
  private async nextReceiptNumber(tx: Tx, organisationId: string): Promise<string> {
    const [row] = await tx.$queryRaw<{ prefix: string; n: number }[]>`
      INSERT INTO receipt_settings (organisation_id, next_number, updated_at)
      VALUES (${organisationId}::uuid, 2, now())
      ON CONFLICT (organisation_id) DO UPDATE
        SET next_number = receipt_settings.next_number + 1, updated_at = now()
      RETURNING prefix, next_number - 1 AS n`;
    return formatReceiptNumber(row!.prefix, Number(row!.n));
  }

  private async uniqueName<T>(write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new AppError(409, 'CONFLICT', 'The price list already has an item with this name.', {
          name: 'taken',
        });
      }
      throw error;
    }
  }

  private lineOut = (row: BillRow['items'][number]) => ({
    id: row.id,
    kind: row.kind,
    priceListItemId: row.priceListItemId,
    name: row.name,
    unitPaise: row.unitPaise,
    quantity: row.quantity,
    amountPaise: row.amountPaise,
  });

  private paymentOut(row: PaymentRow, names: Map<string, string | null>): Payment {
    return {
      id: row.id,
      billId: row.billId,
      mode: row.mode,
      amountPaise: row.amountPaise,
      reference: row.reference,
      receiptNumber: row.receiptNumber,
      receivedAt: row.receivedAt.toISOString(),
      receivedByName: names.get(row.receivedByUserId) ?? null,
    };
  }

  private async billOut(row: BillRow): Promise<Bill> {
    const names = await this.names(row.payments.map((p) => p.receivedByUserId));
    return {
      id: row.id,
      appointmentId: row.appointmentId,
      status: row.status,
      lines: row.items.map(this.lineOut),
      subtotalPaise: row.subtotalPaise,
      discountPaise: row.discountPaise,
      discountReason: row.discountReason,
      totalPaise: row.totalPaise,
      paidPaise: row.paidPaise,
      balancePaise: row.totalPaise - row.paidPaise,
      revision: row.revision,
      payments: row.payments.map((p) => this.paymentOut(p, names)),
    };
  }

  /** Display names of staff (users are platform-level, outside tenant RLS). */
  private async names(userIds: string[]): Promise<Map<string, string | null>> {
    const ids = [...new Set(userIds)];
    if (ids.length === 0) return new Map();
    const users = await withAuth(this.s.db, (tx) =>
      tx.user.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true } }),
    );
    return new Map(users.map((u) => [u.id, u.displayName]));
  }

  private audit(
    tx: Tx,
    request: FastifyRequest,
    actor: Actor,
    action: string,
    entityType: string,
    entityId: string,
    metadata: Prisma.InputJsonValue,
  ) {
    return writeAudit(tx, request, {
      action,
      organisationId: actor.organisationId,
      actorUserId: actor.userId,
      entityType,
      entityId,
      metadata,
    });
  }
}
