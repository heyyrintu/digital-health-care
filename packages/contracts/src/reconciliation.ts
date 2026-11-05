import { z } from 'zod';
import { page } from './pagination';
export const ReconIssueCode = z.enum([
  'unknown_order',
  'merchant_mismatch',
  'payment_missing',
  'payment_mismatch',
  'refund_missing',
  'refund_mismatch',
  'refund_reference_missing',
  'provider_status_conflict',
  'ledger_payment_not_in_report',
  'ledger_refund_not_in_report',
  'settlement_not_successful',
  'settlement_gross_mismatch',
  'settlement_net_mismatch',
  'settlement_events_missing',
  'adjustment_review',
  'currency_mismatch',
  'direction_mismatch',
  'provider_identity_conflict',
  'unsupported_charging_basis',
]);
export const ReconReviewReason = z.enum([
  'timing_difference',
  'fees_explained',
  'external_transaction',
  'contacted_provider',
  'other',
]);
export const ReconRun = z.object({
  id: z.uuid(),
  fromDate: z.iso.date(),
  toDate: z.iso.date(),
  environment: z.enum(['sandbox', 'production']),
  status: z.enum(['queued', 'running', 'succeeded', 'failed']),
  attempts: z.number().int(),
  eventCount: z.number().int(),
  settlementCount: z.number().int(),
  mismatchCount: z.number().int(),
  createdAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
  errorCode: z
    .enum([
      'provider_unavailable',
      'invalid_report',
      'limit_exceeded',
      'binding_changed',
      'processing_failed',
    ])
    .nullable(),
});
export type ReconRun = z.infer<typeof ReconRun>;
export const ReconRunList = page(ReconRun);
export const CreateReconRun = z
  .object({ id: z.uuid(), fromDate: z.iso.date(), toDate: z.iso.date() })
  .strict()
  .refine(
    (v) => {
      const days = (Date.parse(v.toDate) - Date.parse(v.fromDate)) / 86400000;
      return days >= 0 && days <= 30;
    },
    { message: 'Choose a period of 1 to 31 days.' },
  );
export const ReconIssue = z.object({
  id: z.uuid(),
  code: ReconIssueCode,
  severity: z.enum(['attention', 'info']),
  providerReference: z.string().nullable(),
  settlementId: z.string().nullable(),
  orderId: z.uuid().nullable(),
  paymentId: z.uuid().nullable(),
  appointmentId: z.uuid().nullable(),
  expectedPaise: z.number().int().nullable(),
  reportedPaise: z.number().int().nullable(),
  reviewedAt: z.iso.datetime().nullable(),
  reviewReason: ReconReviewReason.nullable(),
});
export type ReconIssue = z.infer<typeof ReconIssue>;
export const ReconIssueList = page(ReconIssue);
export const ReconSettlement = z.object({
  id: z.uuid(),
  settlementId: z.string(),
  status: z.string(),
  chargingBasis: z.string(),
  utr: z.string().nullable(),
  grossPaise: z.number().int(),
  feesPaise: z.number().int(),
  taxPaise: z.number().int(),
  adjustmentPaise: z.number().int(),
  netPaise: z.number().int(),
});
export type ReconSettlement = z.infer<typeof ReconSettlement>;
export const ReconSettlementList = page(ReconSettlement);
export const ReconOverview = z.object({ enabled: z.boolean(), runs: ReconRunList });
export const ReconDetail = z.object({ run: ReconRun, unreviewedCount: z.number().int() });
export const ReviewReconIssue = z.object({ reason: ReconReviewReason }).strict();

export type ReconReviewReason = z.infer<typeof ReconReviewReason>;
export const ReconReviewResult = z.object({ reviewed: z.literal(true) });
