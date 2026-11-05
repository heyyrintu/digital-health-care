import { ReportFailure, reportPaise, type ReportEvent, type ReportSettlement } from '@dhc/cashfree';
import { createHash } from 'node:crypto';
export const key = (...parts: unknown[]) =>
  createHash('sha256').update(JSON.stringify(parts)).digest('hex');
export interface LocalOrder {
  id: string;
  providerOrderId: string;
  merchantClientId: string;
  environment: string;
  amountPaise: number;
  currency: string;
  status: string;
  providerPaymentId: string | null;
  appointmentId: string;
  payment: { id: string; reference: string | null; amountPaise: number; receivedAt: Date } | null;
  refunds: {
    id: string;
    merchantRefundId: string;
    amountPaise: number;
    status: string;
    entry: { amountPaise: number; postedAt: Date } | null;
  }[];
}
export interface NormalEvent {
  stream: 'pg' | 'settlement';
  eventKey: string;
  kind: string;
  providerEventId: string;
  status: string | null;
  orderReference: string | null;
  paymentReference: string | null;
  refundReference: string | null;
  settlementId: string | null;
  currency: string | null;
  amountPaise: number | null;
  feesPaise: number | null;
  taxPaise: number | null;
  netPaise: number | null;
  direction: string | null;
}
export interface NormalSettlement {
  settlementId: string;
  status: string;
  utr: string | null;
  grossPaise: number;
  feesPaise: number;
  taxPaise: number;
  adjustmentPaise: number;
  netPaise: number;
  chargingBasis: string;
}
export interface Issue {
  issueKey: string;
  code: string;
  severity: 'attention' | 'info';
  providerReference: string | null;
  settlementId: string | null;
  orderId: string | null;
  paymentId: string | null;
  appointmentId: string | null;
  expectedPaise: number | null;
  reportedPaise: number | null;
}
const money = (n: number | string | null | undefined) => (n == null ? null : reportPaise(n));
export function normalizeEvent(row: ReportEvent, stream: 'pg' | 'settlement'): NormalEvent {
  const e = row.event_details,
    refs = [
      ...new Set(
        (row.refund_details ?? []).map((r) => r.refund_id).filter((v): v is string => !!v),
      ),
    ];
  return {
    stream,
    eventKey: key(e.event_type, e.event_id, row.settlement_details?.cf_settlement_id ?? null),
    kind: e.event_type,
    providerEventId: e.event_id,
    status: e.event_status ?? null,
    orderReference: row.order_details?.order_id ?? null,
    paymentReference: row.payment_details?.cf_payment_id ?? null,
    refundReference: refs.length === 1 ? refs[0]! : null,
    settlementId: row.settlement_details?.cf_settlement_id ?? null,
    currency: e.event_currency ?? null,
    amountPaise: money(e.event_amount),
    feesPaise: money(e.event_service_charge),
    taxPaise: money(e.event_service_tax),
    netPaise: money(e.event_settlement_amount),
    direction: e.sale_type ?? null,
  };
}
export function normalizeSettlement(row: ReportSettlement): NormalSettlement {
  return {
    settlementId: row.cf_settlement_id,
    status: row.status,
    utr: row.settlement_utr ?? null,
    grossPaise: reportPaise(row.payment_amount),
    feesPaise: [
      row.pg_service_charge,
      row.settlement_charge,
      row.split_service_charge,
      row.vendor_commission,
    ].reduce<number>((n, v) => n + reportPaise(v), 0),
    taxPaise: [row.pg_service_tax, row.settlement_tax, row.split_service_tax].reduce<number>(
      (n, v) => n + reportPaise(v),
      0,
    ),
    adjustmentPaise: reportPaise(row.adjustment),
    netPaise: reportPaise(row.amount_settled),
    chargingBasis: row.charge_type,
  };
}
export function uniqueRows<T>(rows: T[], identity: (row: T) => string): T[] {
  const index = new Map<string, T>();
  for (const row of rows) {
    const id = identity(row),
      prior = index.get(id);
    if (prior && JSON.stringify(prior) !== JSON.stringify(row))
      throw new ReportFailure('invalid_report');
    index.set(id, row);
  }
  return [...index.values()];
}
export function matchReports(
  events: NormalEvent[],
  settlements: NormalSettlement[],
  orders: LocalOrder[],
  merchant: { clientId: string; environment: string },
  from: Date,
  to: Date,
): Issue[] {
  const issues = new Map<string, Issue>(),
    known = new Map(orders.map((o) => [o.providerOrderId, o]));
  const seenPayments = new Set<string>(),
    seenRefunds = new Set<string>();
  function add(
    code: string,
    reference: string | null,
    order: LocalOrder | null = null,
    settlementId: string | null = null,
    expectedPaise: number | null = null,
    reportedPaise: number | null = null,
    severity: 'attention' | 'info' = 'attention',
  ) {
    const id = key(code, reference, settlementId);
    issues.set(id, {
      issueKey: id,
      code,
      severity,
      providerReference: reference,
      settlementId,
      orderId: order?.id ?? null,
      paymentId: order?.payment?.id ?? null,
      appointmentId: order?.appointmentId ?? null,
      expectedPaise,
      reportedPaise,
    });
  }
  const identities = new Map<string, NormalEvent>();
  for (const event of events) {
    const o = event.orderReference ? (known.get(event.orderReference) ?? null) : null,
      reference = event.providerEventId;
    const fingerprint = key(event.kind, reference),
      prior = identities.get(fingerprint);
    if (
      prior &&
      [
        prior.amountPaise !== null &&
          event.amountPaise !== null &&
          prior.amountPaise !== event.amountPaise,
        prior.currency && event.currency && prior.currency !== event.currency,
        prior.paymentReference &&
          event.paymentReference &&
          prior.paymentReference !== event.paymentReference,
        prior.settlementId && event.settlementId && prior.settlementId !== event.settlementId,
        prior.refundReference &&
          event.refundReference &&
          prior.refundReference !== event.refundReference,
      ].some(Boolean)
    )
      add('provider_identity_conflict', reference, o);
    identities.set(fingerprint, event);
    if (event.kind !== 'PAYMENT' && event.kind !== 'REFUND') {
      add('adjustment_review', reference, o, event.settlementId, null, event.amountPaise);
      continue;
    }
    if (
      o?.payment &&
      event.stream === 'pg' &&
      event.kind === 'PAYMENT' &&
      event.paymentReference === o.payment.reference
    )
      seenPayments.add(o.payment.id);
    const refund = o?.refunds.find((r) => r.merchantRefundId === event.refundReference);
    if (refund && event.kind === 'REFUND' && event.stream === 'pg') seenRefunds.add(refund.id);
    if (event.status !== 'SUCCESS') {
      if (
        (event.kind === 'PAYMENT' && o?.payment?.reference === event.paymentReference) ||
        (event.kind === 'REFUND' && refund?.entry)
      )
        add('provider_status_conflict', reference, o, event.settlementId);
      continue;
    }
    if (!o) {
      add(
        'unknown_order',
        event.orderReference ?? reference,
        null,
        event.settlementId,
        null,
        event.amountPaise,
      );
      continue;
    }
    if (o.merchantClientId !== merchant.clientId || o.environment !== merchant.environment) {
      add('merchant_mismatch', reference, o, event.settlementId);
      continue;
    }
    if (event.currency !== 'INR' || event.currency !== o.currency) {
      add('currency_mismatch', reference, o, event.settlementId);
      continue;
    }
    if (
      event.amountPaise === null ||
      event.amountPaise < 0 ||
      event.direction !== (event.kind === 'PAYMENT' ? 'CREDIT' : 'DEBIT')
    ) {
      add('direction_mismatch', reference, o, event.settlementId);
      continue;
    }
    if (event.kind === 'PAYMENT') {
      if (!o.payment || o.status !== 'paid') {
        add('payment_missing', reference, o, event.settlementId, o.amountPaise, event.amountPaise);
        continue;
      }
      if (
        !event.paymentReference ||
        o.payment.reference !== event.paymentReference ||
        o.providerPaymentId !== event.paymentReference ||
        o.amountPaise !== event.amountPaise ||
        o.payment.amountPaise !== event.amountPaise
      )
        add(
          'payment_mismatch',
          reference,
          o,
          event.settlementId,
          o.payment.amountPaise,
          event.amountPaise,
        );
    } else {
      if (!event.refundReference) {
        add('refund_reference_missing', reference, o, event.settlementId, null, event.amountPaise);
        continue;
      }
      if (!refund?.entry) {
        add(
          'refund_missing',
          event.refundReference,
          o,
          event.settlementId,
          null,
          event.amountPaise,
        );
        continue;
      }
      if (
        refund.entry.amountPaise !== event.amountPaise ||
        (event.paymentReference && event.paymentReference !== o.payment?.reference)
      )
        add(
          'refund_mismatch',
          event.refundReference,
          o,
          event.settlementId,
          refund.entry.amountPaise,
          event.amountPaise,
        );
    }
  }
  for (const o of orders) {
    if (o.merchantClientId !== merchant.clientId || o.environment !== merchant.environment)
      continue;
    if (
      o.payment &&
      o.payment.receivedAt >= from &&
      o.payment.receivedAt < to &&
      !seenPayments.has(o.payment.id)
    )
      add('ledger_payment_not_in_report', o.providerOrderId, o, null, o.payment.amountPaise, null);
    for (const r of o.refunds)
      if (r.entry && r.entry.postedAt >= from && r.entry.postedAt < to && !seenRefunds.has(r.id))
        add('ledger_refund_not_in_report', r.merchantRefundId, o, null, r.entry.amountPaise, null);
  }
  for (const s of settlements) {
    if (s.status !== 'SUCCESS')
      add(
        'settlement_not_successful',
        s.settlementId,
        null,
        s.settlementId,
        null,
        s.netPaise,
        'info',
      );
    const breakdown = events.filter(
      (e) => e.stream === 'settlement' && e.settlementId === s.settlementId,
    );
    if (!breakdown.length && s.grossPaise !== 0)
      add('settlement_events_missing', s.settlementId, null, s.settlementId, s.grossPaise, null);
    else {
      const total = breakdown
        .filter((e) => e.kind === 'PAYMENT' && e.status === 'SUCCESS' && e.direction === 'CREDIT')
        .reduce((n, e) => n + (e.amountPaise ?? 0), 0);
      if (!Number.isSafeInteger(total)) throw new ReportFailure('invalid_report');
      if (total !== s.grossPaise)
        add('settlement_gross_mismatch', s.settlementId, null, s.settlementId, s.grossPaise, total);
    }
    if (s.chargingBasis === 'PREPAID') {
      const expected = s.grossPaise - s.feesPaise - s.taxPaise + s.adjustmentPaise;
      if (expected !== s.netPaise)
        add('settlement_net_mismatch', s.settlementId, null, s.settlementId, expected, s.netPaise);
    } else add('unsupported_charging_basis', s.settlementId, null, s.settlementId);
    if (s.adjustmentPaise !== 0)
      add('adjustment_review', s.settlementId, null, s.settlementId, null, s.adjustmentPaise);
  }
  return [...issues.values()];
}
