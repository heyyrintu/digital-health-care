import { z } from 'zod';
import type { Merchant } from './index';

/** Keep reported financial identifiers and amounts, never raw customer/bank/note objects. */
const Ref = z.union([
  z.string().min(1).max(128),
  z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).transform(String),
]);
const Money = z.union([z.number(), z.string()]);
const Amount = Money.nullish();
const Word = z.string().regex(/^[A-Z0-9_ -]{1,64}$/);
const Currency = z
  .string()
  .regex(/^[A-Z]{3}$/)
  .nullish();
export const ReportEvent = z.object({
  event_details: z.object({
    event_id: Ref,
    event_type: Word,
    event_status: Word.nullish(),
    event_amount: Amount,
    event_currency: Currency,
    event_service_charge: Amount,
    event_service_tax: Amount,
    event_settlement_amount: Amount,
    event_time: z.string().max(64).nullish(),
    sale_type: Word.nullish(),
  }),
  order_details: z
    .object({ order_id: Ref.nullish(), order_amount: Amount, order_currency: Currency })
    .nullish(),
  payment_details: z
    .object({
      cf_payment_id: Ref.nullish(),
      payment_amount: Amount,
      payment_currency: Currency,
      status: Word.nullish(),
    })
    .nullish(),
  refund_details: z
    .array(z.object({ refund_id: Ref.nullish() }))
    .max(2000)
    .nullish(),
  settlement_details: z.object({ cf_settlement_id: Ref.nullish() }).nullish(),
});
export type ReportEvent = z.infer<typeof ReportEvent>;
export const ReportSettlement = z.object({
  cf_settlement_id: Ref,
  status: Word,
  settlement_utr: z.string().max(128).nullish(),
  payment_amount: Money,
  pg_service_charge: Money,
  pg_service_tax: Money,
  adjustment: Money,
  settlement_charge: Money,
  settlement_tax: Money,
  split_service_charge: Money,
  split_service_tax: Money,
  vendor_commission: Money,
  amount_settled: Money,
  charge_type: Word,
  settlement_initiated_on: z.string().max(64).nullish(),
  settlement_processed_on: z.string().max(64).nullish(),
});
export type ReportSettlement = z.infer<typeof ReportSettlement>;
export interface ReportPage<T> {
  data: T[];
  cursor: string | null;
}
export interface ReportingGateway {
  settlements(
    m: Merchant,
    from: string,
    to: string,
    cursor: string | null,
  ): Promise<ReportPage<ReportSettlement>>;
  events(
    m: Merchant,
    from: string,
    to: string,
    cursor: string | null,
  ): Promise<ReportPage<ReportEvent>>;
  settlementEvents(
    m: Merchant,
    ids: string[],
    cursor: string | null,
  ): Promise<ReportPage<ReportEvent>>;
}
export class ReportFailure extends Error {
  constructor(
    readonly code:
      'provider_unavailable' | 'invalid_report' | 'limit_exceeded' = 'provider_unavailable',
  ) {
    super('Cashfree reconciliation could not complete');
  }
}
/** Signed paise for reports, capped at ₹100 crore per field; no rounding of fractional paise. */
export function reportPaise(value: number | string): number {
  const text = String(value);
  if (!/^-?\d{1,10}(?:\.\d{1,2})?$/.test(text)) throw new ReportFailure('invalid_report');
  const negative = text.startsWith('-'),
    [whole, part = ''] = text.replace(/^-/, '').split('.');
  const n = Number(whole) * 100 + Number(part.padEnd(2, '0'));
  if (!Number.isSafeInteger(n) || n > 100_000_000_000) throw new ReportFailure('invalid_report');
  return negative ? -n : n;
}
export class CashfreeReportingGateway implements ReportingGateway {
  constructor(private readonly fetcher: typeof fetch = fetch) {}
  private async page<T>(
    m: Merchant,
    path: string,
    filters: object,
    cursor: string | null,
    schema: z.ZodType<T>,
  ): Promise<ReportPage<T>> {
    try {
      const host =
        m.environment === 'production'
          ? 'https://api.cashfree.com/pg'
          : 'https://sandbox.cashfree.com/pg';
      const response = await this.fetcher(host + path, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
        headers: {
          'Content-Type': 'application/json',
          'x-api-version': '2026-01-01',
          'x-client-id': m.clientId,
          'x-client-secret': m.clientSecret,
        },
        body: JSON.stringify({ pagination: { limit: 100, cursor }, filters }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new ReportFailure();
      }
      const reader = response.body?.getReader();
      if (!reader) throw new ReportFailure();
      const parts: Uint8Array[] = [];
      let bytes = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.length;
        if (bytes > 1_000_000) {
          await reader.cancel();
          throw new ReportFailure('limit_exceeded');
        }
        parts.push(chunk.value);
      }
      const result = z
        .object({ data: z.array(schema).max(100), cursor: z.string().max(8192).nullable() })
        .safeParse(JSON.parse(Buffer.concat(parts).toString('utf8')));
      if (!result.success) throw new ReportFailure('invalid_report');
      return { data: result.data.data, cursor: result.data.cursor || null };
    } catch (e) {
      if (e instanceof ReportFailure) throw e;
      throw new ReportFailure();
    }
  }
  settlements(m: Merchant, from: string, to: string, cursor: string | null) {
    return this.page(
      m,
      '/settlements',
      { start_date: from, end_date: to },
      cursor,
      ReportSettlement,
    );
  }
  events(m: Merchant, from: string, to: string, cursor: string | null) {
    return this.page(m, '/recon', { start_date: from, end_date: to }, cursor, ReportEvent);
  }
  settlementEvents(m: Merchant, ids: string[], cursor: string | null) {
    return this.page(m, '/settlement/recon', { cf_settlement_ids: ids }, cursor, ReportEvent);
  }
}
export async function allReportPages<T>(
  read: (cursor: string | null) => Promise<ReportPage<T>>,
  heartbeat?: () => Promise<void>,
): Promise<T[]> {
  const rows: T[] = [],
    seen = new Set<string>();
  let cursor: string | null = null;
  for (let n = 0; n < 100; n++) {
    await heartbeat?.();
    const page = await read(cursor);
    rows.push(...page.data);
    if (rows.length > 10000) throw new ReportFailure('limit_exceeded');
    if (!page.cursor) return rows;
    if (seen.has(page.cursor)) throw new ReportFailure('invalid_report');
    seen.add(page.cursor);
    cursor = page.cursor;
  }
  throw new ReportFailure('limit_exceeded');
}
