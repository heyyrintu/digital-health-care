import { describe, expect, it } from 'vitest';
import {
  matchReports,
  uniqueRows,
  type NormalEvent,
  type LocalOrder,
  type NormalSettlement,
} from './match';
import { reportBounds, istToday } from './index';
const from = new Date('2026-11-01T00:00:00Z'),
  to = new Date('2026-11-02T00:00:00Z');
const merchant = { clientId: 'm', environment: 'sandbox' };
const order: LocalOrder = {
  id: 'o',
  providerOrderId: 'remote',
  merchantClientId: 'm',
  environment: 'sandbox',
  amountPaise: 100000,
  currency: 'INR',
  status: 'paid',
  providerPaymentId: 'p',
  appointmentId: 'a',
  payment: { id: 'receipt', reference: 'p', amountPaise: 100000, receivedAt: from },
  refunds: [
    {
      id: 'r',
      merchantRefundId: 'rf',
      amountPaise: 1000,
      status: 'succeeded',
      entry: { amountPaise: 1000, postedAt: from },
    },
  ],
};
const event: NormalEvent = {
  stream: 'pg',
  eventKey: 'e',
  kind: 'PAYMENT',
  providerEventId: 'p',
  status: 'SUCCESS',
  orderReference: 'remote',
  paymentReference: 'p',
  refundReference: null,
  settlementId: 's',
  currency: 'INR',
  amountPaise: 100000,
  feesPaise: 2000,
  taxPaise: 360,
  netPaise: 100000,
  direction: 'CREDIT',
};
const refund: NormalEvent = {
  ...event,
  eventKey: 'r',
  kind: 'REFUND',
  providerEventId: 'refund-event',
  refundReference: 'rf',
  amountPaise: 1000,
  direction: 'DEBIT',
};
const settlement: NormalSettlement = {
  settlementId: 's',
  status: 'SUCCESS',
  utr: 'utr',
  grossPaise: 100000,
  feesPaise: 2000,
  taxPaise: 360,
  adjustmentPaise: 0,
  netPaise: 97640,
  chargingBasis: 'PREPAID',
};
const match = (
  events: NormalEvent[],
  settlements: NormalSettlement[] = [],
  orders: LocalOrder[] = [order],
) => matchReports(events, settlements, orders, merchant, from, to);
describe('immutable settlement matching', () => {
  it('matches payment/refund ledgers and gross/fees/tax/net without imposing event fee arithmetic', () => {
    expect(match([event, refund, { ...event, stream: 'settlement' }], [settlement])).toEqual([]);
  });
  it('never guesses refund identity from an event ID', () => {
    expect(
      match([event, { ...refund, refundReference: null, providerEventId: 'rf' }]).map(
        (i) => i.code,
      ),
    ).toEqual(expect.arrayContaining(['refund_reference_missing', 'ledger_refund_not_in_report']));
  });
  it('identifies unknown accounts, missing receipts, identity conflicts and changed amounts', () => {
    expect(match([{ ...event, orderReference: 'unknown' }]).map((i) => i.code)).toContain(
      'unknown_order',
    );
    expect(
      match([event], [], [{ ...order, merchantClientId: 'other' }]).map((i) => i.code),
    ).toContain('merchant_mismatch');
    expect(match([event], [], [{ ...order, payment: null }]).map((i) => i.code)).toContain(
      'payment_missing',
    );
    expect(
      match([event, { ...event, stream: 'settlement', amountPaise: 3 }]).map((i) => i.code),
    ).toContain('provider_identity_conflict');
  });
  it('flags ledger-only rows based on posting date, excluding rows outside the chosen period', () => {
    expect(match([]).map((i) => i.code)).toEqual([
      'ledger_payment_not_in_report',
      'ledger_refund_not_in_report',
    ]);
    expect(
      match([], [], [{ ...order, payment: { ...order.payment!, receivedAt: to }, refunds: [] }]),
    ).toEqual([]);
  });
  it('keeps pending settlements informational and adjustments reviewable; detects incomplete gross and incorrect net', () => {
    const result = match(
      [event, refund],
      [{ ...settlement, status: 'PENDING', netPaise: 1, adjustmentPaise: -1000 }],
    );
    expect(result).toContainEqual(
      expect.objectContaining({ code: 'settlement_not_successful', severity: 'info' }),
    );
    expect(result.map((i) => i.code)).toEqual(
      expect.arrayContaining([
        'settlement_net_mismatch',
        'settlement_events_missing',
        'adjustment_review',
      ]),
    );
  });
  it('does not treat a payment row carrying refund metadata as a refund event, or accept one transaction in two settlements', () => {
    expect(match([{ ...event, refundReference: 'rf' }]).map((i) => i.code)).toContain(
      'ledger_refund_not_in_report',
    );
    expect(
      match([event, refund, { ...event, stream: 'settlement', settlementId: 'another' }]).map(
        (i) => i.code,
      ),
    ).toContain('provider_identity_conflict');
  });
  it('rejects conflicting duplicate pages; exact duplicates are harmless', () => {
    expect(uniqueRows([event, { ...event }], (e) => e.eventKey)).toEqual([event]);
    expect(() => uniqueRows([event, { ...event, amountPaise: 1 }], (e) => e.eventKey)).toThrow();
  });
  it('converts inclusive IST dates to provider instants without using the host timezone', () => {
    expect(reportBounds(from, from)).toMatchObject({
      from: '2026-10-31T18:30:00.000Z',
      to: '2026-11-01T18:29:59.999Z',
    });
    expect(istToday(new Date('2026-11-01T19:00:00Z'))).toBe('2026-11-02');
  });
});
