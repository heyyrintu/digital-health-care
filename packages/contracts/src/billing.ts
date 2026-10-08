import { z } from 'zod';

/** Whole paise, up to ₹1,00,000. */
const Paise = z.number().int().min(0).max(10_000_000);

export const BillStatus = z.enum(['due', 'partly_paid', 'paid']);
export type BillStatus = z.infer<typeof BillStatus>;

/** Counter payment modes (PRD §5.6); online payments arrive with Cashfree. */
export const PaymentMode = z.enum(['cash', 'upi', 'card']);
export type PaymentMode = z.infer<typeof PaymentMode>;

/** `consultation` and `follow_up` take the visit's fee; `item` comes from the price list. */
export const BillLineKind = z.enum(['consultation', 'follow_up', 'item']);
export type BillLineKind = z.infer<typeof BillLineKind>;

// ---- Price list ----------------------------------------------------------------------

export const PriceListItem = z.object({
  id: z.uuid(),
  name: z.string(),
  pricePaise: z.number().int(),
  active: z.boolean(),
});
export type PriceListItem = z.infer<typeof PriceListItem>;

export const PriceList = z.object({ data: z.array(PriceListItem) });
export type PriceList = z.infer<typeof PriceList>;

export const CreatePriceListItemBody = z.object({
  name: z.string().trim().min(1).max(80),
  pricePaise: Paise.min(1),
});
export type CreatePriceListItemBody = z.infer<typeof CreatePriceListItemBody>;

export const UpdatePriceListItemBody = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    pricePaise: Paise.min(1).optional(),
    active: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to change.' });
export type UpdatePriceListItemBody = z.infer<typeof UpdatePriceListItemBody>;

// ---- Bills ---------------------------------------------------------------------------

export const BillLine = z.object({
  id: z.uuid(),
  kind: BillLineKind,
  priceListItemId: z.uuid().nullable(),
  /** As billed; later price-list changes do not touch it. */
  name: z.string(),
  unitPaise: z.number().int(),
  quantity: z.number().int(),
  amountPaise: z.number().int(),
});
export type BillLine = z.infer<typeof BillLine>;

export const Payment = z.object({
  id: z.uuid(),
  billId: z.uuid(),
  mode: PaymentMode,
  amountPaise: z.number().int(),
  reference: z.string().nullable(),
  receiptNumber: z.string(),
  receivedAt: z.iso.datetime(),
  receivedByName: z.string().nullable(),
});
export type Payment = z.infer<typeof Payment>;

export const Bill = z.object({
  id: z.uuid(),
  appointmentId: z.uuid(),
  status: BillStatus,
  lines: z.array(BillLine),
  subtotalPaise: z.number().int(),
  discountPaise: z.number().int(),
  discountReason: z.string().nullable(),
  totalPaise: z.number().int(),
  paidPaise: z.number().int(),
  balancePaise: z.number().int(),
  /** Send back with the next save; a stale revision is rejected. */
  revision: z.number().int(),
  payments: z.array(Payment),
});
export type Bill = z.infer<typeof Bill>;

/** What the queue card shows (PRD §5.1 "billed amount"). */
export const BillSummary = z.object({
  totalPaise: z.number().int(),
  paidPaise: z.number().int(),
  status: BillStatus,
});
export type BillSummary = z.infer<typeof BillSummary>;

/** A visit's bill and what the bill screen needs to build or change it. */
export const BillView = z.object({
  bill: Bill.nullable(),
  consultationTypeName: z.string(),
  feePaise: z.number().int(),
  followUpFeePaise: z.number().int().nullable(),
  /** Lines and discount can change until the first payment (front desk and doctors). */
  canEdit: z.boolean(),
  canPay: z.boolean(),
});
export type BillView = z.infer<typeof BillView>;

/**
 * The whole bill. Amounts are not sent: the server prices every line from the visit's
 * consultation type and the price list.
 */
export const SaveBillBody = z
  .object({
    /** 0 for a new bill. */
    revision: z.number().int().min(0),
    consultation: z.enum(['consultation', 'follow_up', 'none']),
    items: z
      .array(
        z.object({
          priceListItemId: z.uuid(),
          quantity: z.number().int().min(1).max(99),
        }),
      )
      .max(30),
    discountPaise: Paise.default(0),
    discountReason: z.string().trim().min(1).max(200).nullable().default(null),
  })
  .refine((body) => body.discountPaise === 0 || body.discountReason !== null, {
    message: 'A discount needs a reason.',
    path: ['discountReason'],
  })
  .refine((body) => body.consultation !== 'none' || body.items.length > 0, {
    message: 'A bill needs at least one line.',
    path: ['items'],
  });
export type SaveBillBody = z.infer<typeof SaveBillBody>;

/** The ID is made by the client, so a retried request records the payment once. */
export const RecordPaymentBody = z.object({
  id: z.uuid(),
  mode: PaymentMode,
  amountPaise: Paise.min(1),
  reference: z.string().trim().min(1).max(60).nullable().default(null),
});
export type RecordPaymentBody = z.infer<typeof RecordPaymentBody>;

// ---- Receipts and collections ------------------------------------------------------

export const Receipt = z.object({
  payment: Payment,
  appointmentId: z.uuid(),
  organisationName: z.string(),
  patient: z.object({ name: z.string(), uhid: z.string() }),
  doctorName: z.string().nullable(),
  /** IST day of the visit. */
  visitDate: z.iso.date(),
  lines: z.array(BillLine),
  subtotalPaise: z.number().int(),
  discountPaise: z.number().int(),
  totalPaise: z.number().int(),
  /** Collected with this and earlier payments, and what remained after this one. */
  paidToDatePaise: z.number().int(),
  balanceAfterPaise: z.number().int(),
});
export type Receipt = z.infer<typeof Receipt>;

export const CollectionsQuery = z.object({
  /** Defaults to today (IST). */
  date: z.iso.date().optional(),
});
export type CollectionsQuery = z.infer<typeof CollectionsQuery>;

export const CollectionPayment = Payment.extend({
  appointmentId: z.uuid(),
  patientName: z.string(),
  uhid: z.string(),
  doctorName: z.string().nullable(),
});
export type CollectionPayment = z.infer<typeof CollectionPayment>;

/** One day's counter collections (PRD §5.6 "collection reports by mode and doctor"). */
export const CollectionsReport = z.object({
  date: z.iso.date(),
  totalPaise: z.number().int(),
  byMode: z.array(
    z.object({ mode: PaymentMode, count: z.number().int(), amountPaise: z.number().int() }),
  ),
  byDoctor: z.array(
    z.object({
      doctorUserId: z.uuid(),
      doctorName: z.string().nullable(),
      count: z.number().int(),
      amountPaise: z.number().int(),
    }),
  ),
  payments: z.array(CollectionPayment),
  /** The day's visits whose bills still have money to collect. */
  dues: z.array(
    z.object({
      billId: z.uuid(),
      appointmentId: z.uuid(),
      patientName: z.string(),
      uhid: z.string(),
      doctorName: z.string().nullable(),
      balancePaise: z.number().int(),
    }),
  ),
});
export type CollectionsReport = z.infer<typeof CollectionsReport>;
