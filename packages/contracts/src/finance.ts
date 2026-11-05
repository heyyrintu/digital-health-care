import { z } from 'zod';
import { page, CursorQuery } from './pagination';
import { PaymentMode, Receipt } from './billing';
export const PortalFinanceQuery = CursorQuery.extend({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.uuid().optional(),
  patientId: z.uuid().optional(),
});
export const PortalBill = z.object({
  id: z.uuid(),
  appointmentId: z.uuid(),
  patient: z.object({ id: z.uuid(), name: z.string(), uhid: z.string() }),
  visitDate: z.iso.date(),
  totalPaise: z.number().int(),
  paidPaise: z.number().int(),
  balancePaise: z.number().int(),
  refundedPaise: z.number().int(),
  netCollectedPaise: z.number().int(),
  canPay: z.boolean(),
  prepaidBookingId: z.uuid().nullable(),
  order: z
    .object({
      id: z.uuid(),
      status: z.string(),
      expiresAt: z.iso.datetime(),
      paymentUrl: z.url().nullable(),
    })
    .nullable(),
});
export type PortalBill = z.infer<typeof PortalBill>;
export const PortalBillList = page(PortalBill);
export const PortalReceiptSummary = z.object({
  id: z.uuid(),
  billId: z.uuid(),
  receiptNumber: z.string(),
  patientName: z.string(),
  amountPaise: z.number().int(),
  mode: PaymentMode,
  receivedAt: z.iso.datetime(),
});
export type PortalReceiptSummary = z.infer<typeof PortalReceiptSummary>;
export const PortalReceiptList = page(PortalReceiptSummary);
export const PortalCheckoutBody = z.object({ id: z.uuid() }).strict();
export const FinanceLinkTarget = z.object({
  kind: z.enum(['payment_link', 'receipt_ready', 'refund_ready']),
  sourceId: z.uuid(),
  paymentUrl: z.url().nullable(),
});
export const PortalReceipt = Receipt.extend({
  refunds: z.array(
    z.object({
      id: z.uuid(),
      voucherNumber: z.string(),
      amountPaise: z.number().int(),
      postedAt: z.iso.datetime(),
    }),
  ),
});
export type PortalReceipt = z.infer<typeof PortalReceipt>;

export type FinanceLinkTarget = z.infer<typeof FinanceLinkTarget>;
