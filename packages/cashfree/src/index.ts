import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export const Merchant = z
  .object({
    clientId: z.string().min(1).max(256).regex(/^\S+$/),
    clientSecret: z.string().min(16).max(1024).regex(/^\S+$/),
    environment: z.enum(['sandbox', 'production']).default('sandbox'),
  })
  .strict();
export type Merchant = z.infer<typeof Merchant>;
export function parseMerchants(raw: string): Record<string, Merchant> {
  try {
    const rows = z.record(z.uuid(), Merchant).parse(JSON.parse(raw));
    const ids = Object.values(rows).map((m) => m.environment + ':' + m.clientId);
    if (!ids.length || new Set(ids).size !== ids.length) throw new Error();
    return rows;
  } catch {
    throw new Error('Cashfree merchant configuration must contain distinct clinic accounts');
  }
}
export function toPaise(value: number | string): number {
  const text = String(value);
  if (!/^\d{1,8}(?:\.\d{1,2})?$/.test(text)) throw new Error('Invalid payment amount');
  const [whole, decimal = ''] = text.split('.');
  const amount = Number(whole) * 100 + Number(decimal.padEnd(2, '0'));
  if (!Number.isSafeInteger(amount) || amount > 10_000_000)
    throw new Error('Invalid payment amount');
  return amount;
}
const Money = z.union([z.number(), z.string()]);
const Id = z.union([
  z.string().regex(/^\d{1,60}$/),
  z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).transform(String),
]);
export const ProviderOrder = z.object({
  order_id: z.string().max(64),
  order_amount: Money,
  order_currency: z.string().max(8),
  order_status: z.enum(['ACTIVE', 'PAID', 'EXPIRED', 'TERMINATED', 'TERMINATION_REQUESTED']),
  payment_session_id: z.string().min(1).max(4096).nullish(),
});
export type ProviderOrder = z.infer<typeof ProviderOrder>;
export const ProviderPayment = z.object({
  order_id: z.string().max(64),
  cf_payment_id: Id,
  payment_status: z.string().max(32),
  payment_amount: Money,
  payment_currency: z.string().max(8),
  is_captured: z.boolean().optional(),
});
export type ProviderPayment = z.infer<typeof ProviderPayment>;
export const CashfreeWebhook = z.object({
  type: z.enum([
    'PAYMENT_SUCCESS_WEBHOOK',
    'PAYMENT_FAILED_WEBHOOK',
    'PAYMENT_USER_DROPPED_WEBHOOK',
  ]),
  data: z.object({
    order: z.object({
      order_id: z.string().regex(/^dhc_[0-9a-f]{32}$/),
      order_amount: Money,
      order_currency: z.string().max(8),
    }),
    payment: ProviderPayment.omit({ order_id: true }),
  }),
});
export type CashfreeWebhook = z.infer<typeof CashfreeWebhook>;
export function verifyCashfreeSignature(
  raw: Buffer,
  timestamp: unknown,
  signature: unknown,
  secret: string,
): boolean {
  if (
    typeof timestamp !== 'string' ||
    !/^\d{13}$/.test(timestamp) ||
    typeof signature !== 'string' ||
    !/^[A-Za-z0-9+/]{43}=$/.test(signature)
  )
    return false;
  const expected = createHmac('sha256', secret).update(timestamp).update(raw).digest('base64');
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}
export class CashfreeUnavailable extends Error {
  constructor() {
    super('Payment provider is unavailable. Check the existing payment before trying again.');
  }
}
export interface CreateOrderInput {
  id: string;
  providerOrderId: string;
  amountPaise: number;
  phone: string;
  expiresAt: Date;
  returnUrl: string;
  notifyUrl: string;
}
export interface CashfreeGateway {
  create(merchant: Merchant, input: CreateOrderInput): Promise<ProviderOrder>;
  order(merchant: Merchant, id: string): Promise<ProviderOrder | null>;
  payments(merchant: Merchant, id: string): Promise<ProviderPayment[]>;
  terminate(merchant: Merchant, id: string): Promise<void>;
}
export const ProviderRefund = z.object({
  order_id: z.string().min(1).max(64),
  refund_id: z.string().min(1).max(128),
  cf_refund_id: Id,
  cf_payment_id: Id,
  refund_amount: Money,
  refund_currency: z.string().max(8),
  refund_status: z.enum([
    'SUCCESS',
    'PENDING',
    'PENDING_APPROVAL',
    'CANCELLED',
    'ONHOLD',
    'REJECTED',
    'FAILED',
    'ACTIVE',
  ]),
  refund_type: z.enum(['MERCHANT_INITIATED', 'PAYMENT_AUTO_REFUND', 'UNRECONCILED_AUTO_REFUND']),
});
export type ProviderRefund = z.infer<typeof ProviderRefund>;
export const CashfreeRefundWebhook = z.object({
  type: z.literal('REFUND_STATUS_WEBHOOK'),
  data: z.object({ refund: ProviderRefund }),
});
export interface CreateRefundInput {
  id: string;
  orderId: string;
  refundId: string;
  amountPaise: number;
}
export interface CashfreeRefundGateway {
  createRefund(merchant: Merchant, input: CreateRefundInput): Promise<ProviderRefund>;
  refund(merchant: Merchant, orderId: string, refundId: string): Promise<ProviderRefund | null>;
  refunds(merchant: Merchant, orderId: string): Promise<ProviderRefund[]>;
}
export class CashfreeHttpGateway implements CashfreeGateway, CashfreeRefundGateway {
  constructor(private readonly fetcher: typeof fetch = fetch) {}
  private async request(
    m: Merchant,
    method: string,
    path: string,
    body?: unknown,
    key?: string,
  ): Promise<unknown | null> {
    try {
      const host =
        m.environment === 'production'
          ? 'https://api.cashfree.com/pg'
          : 'https://sandbox.cashfree.com/pg';
      const response = await this.fetcher(host + path, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
        headers: {
          'Content-Type': 'application/json',
          'x-api-version': '2026-01-01',
          'x-client-id': m.clientId,
          'x-client-secret': m.clientSecret,
          ...(key ? { 'x-idempotency-key': key } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (method === 'GET' && response.status === 404) {
        await response.body?.cancel();
        return null;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new CashfreeUnavailable();
      }
      const reader = response.body?.getReader();
      if (!reader) throw new CashfreeUnavailable();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > 512_000) {
          await reader.cancel();
          throw new CashfreeUnavailable();
        }
        chunks.push(part.value);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new CashfreeUnavailable();
    }
  }
  async create(m: Merchant, input: CreateOrderInput) {
    try {
      return ProviderOrder.parse(
        await this.request(
          m,
          'POST',
          '/orders',
          {
            order_id: input.providerOrderId,
            order_amount: input.amountPaise / 100,
            order_currency: 'INR',
            customer_details: { customer_id: input.id, customer_phone: input.phone.slice(-10) },
            order_expiry_time: input.expiresAt.toISOString(),
            order_meta: { return_url: input.returnUrl, notify_url: input.notifyUrl },
          },
          input.id,
        ),
      );
    } catch {
      throw new CashfreeUnavailable();
    }
  }
  async order(m: Merchant, id: string) {
    try {
      const result = await this.request(m, 'GET', `/orders/${encodeURIComponent(id)}`);
      return result === null ? null : ProviderOrder.parse(result);
    } catch {
      throw new CashfreeUnavailable();
    }
  }
  async payments(m: Merchant, id: string) {
    try {
      return z
        .array(ProviderPayment)
        .max(2000)
        .parse(await this.request(m, 'GET', `/orders/${encodeURIComponent(id)}/payments`));
    } catch {
      throw new CashfreeUnavailable();
    }
  }
  async createRefund(m: Merchant, input: CreateRefundInput) {
    try {
      const result = await this.request(
        m,
        'POST',
        `/orders/${encodeURIComponent(input.orderId)}/refunds`,
        {
          refund_id: input.refundId,
          refund_amount: input.amountPaise / 100,
          refund_note: 'Clinic refund',
          refund_speed: 'STANDARD',
        },
        input.id,
      );
      const parsed = z.union([ProviderRefund, z.array(ProviderRefund).length(1)]).parse(result);
      return Array.isArray(parsed) ? parsed[0]! : parsed;
    } catch {
      throw new CashfreeUnavailable();
    }
  }
  async refund(m: Merchant, orderId: string, refundId: string) {
    try {
      const result = await this.request(
        m,
        'GET',
        `/orders/${encodeURIComponent(orderId)}/refunds/${encodeURIComponent(refundId)}`,
      );
      return result === null ? null : ProviderRefund.parse(result);
    } catch {
      throw new CashfreeUnavailable();
    }
  }
  async refunds(m: Merchant, orderId: string) {
    try {
      return z
        .array(ProviderRefund)
        .max(2000)
        .parse(await this.request(m, 'GET', `/orders/${encodeURIComponent(orderId)}/refunds`));
    } catch {
      throw new CashfreeUnavailable();
    }
  }
  async terminate(m: Merchant, id: string) {
    await this.request(m, 'PATCH', `/orders/${encodeURIComponent(id)}`, {
      order_status: 'TERMINATED',
    });
  }
}
export interface CashfreeIntegration {
  acceptNewPayments?: boolean;
  refundsEnabled?: boolean;
  reconciliationEnabled?: boolean;
  prepaidBookingEnabled?: boolean;
  refundGateway?: CashfreeRefundGateway;
  merchants: Record<string, Merchant>;
  gateway: CashfreeGateway;
  linkSecret: string;
  webBaseUrl: string;
  notifyUrl: string;
}
export function paymentToken(id: string, expiresAt: Date, secret: string): string {
  const payload = `p1.${id}.${Math.floor(expiresAt.getTime() / 1000)}`;
  return (
    payload +
    '.' +
    createHmac('sha256', secret)
      .update('dhc-payment-only:' + payload)
      .digest('base64url')
  );
}
/** Pay-only capability: no patient name, clinical record access or session authorization. */
export function paymentTokenId(token: string, secret: string): string | null {
  const match = /^p1\.([0-9a-f-]{36})\.(\d{10,12})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!match || !z.uuid().safeParse(match[1]).success) return null;
  const expected = paymentToken(match[1]!, new Date(Number(match[2]) * 1000), secret);
  return expected.length === token.length &&
    timingSafeEqual(Buffer.from(expected), Buffer.from(token))
    ? match[1]!
    : null;
}

export * from './reports';
