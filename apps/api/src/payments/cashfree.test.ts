import { loadConfig } from '../config';
import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  CashfreeHttpGateway,
  parseMerchants,
  paymentToken,
  paymentTokenId,
  toPaise,
  verifyCashfreeSignature,
  type CreateOrderInput,
  type Merchant,
} from './cashfree';
import { RecordPaymentBody } from '@dhc/contracts';
const merchant: Merchant = {
  clientId: 'synthetic-client',
  clientSecret: 'synthetic-secret-at-least-16',
  environment: 'sandbox',
};
const id = '12345678-1234-4234-8234-123456789abc';
const input: CreateOrderInput = {
  id,
  providerOrderId: 'dhc_' + id.replaceAll('-', ''),
  amountPaise: 12345,
  phone: '+919000000001',
  expiresAt: new Date('2026-11-04T16:00:00Z'),
  returnUrl: 'https://portal.test/pay/opaque',
  notifyUrl: 'https://api.test/v1/webhooks/cashfree',
};
const active = {
  order_id: input.providerOrderId,
  order_amount: 123.45,
  order_currency: 'INR',
  order_status: 'ACTIVE',
  payment_session_id: 'session-synthetic',
};
describe('Cashfree transport and verification', () => {
  it('uses the clinic account, fixed host and pinned API, stable idempotency, and no clinical data', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(active));
    await new CashfreeHttpGateway(fetcher).create(merchant, input);
    const [url, options] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://sandbox.cashfree.com/pg/orders');
    expect(options?.redirect).toBe('error');
    expect(options?.headers).toMatchObject({
      'x-idempotency-key': id,
      'x-api-version': '2026-01-01',
      'x-client-id': merchant.clientId,
    });
    const body = JSON.parse(options!.body as string);
    expect(body.order_amount).toBe(123.45);
    expect(body.customer_details).toEqual({ customer_id: id, customer_phone: '9000000001' });
    expect(JSON.stringify(body)).not.toMatch(/diagnos|patient_name|customer_name|bill_id/);
  });
  it.each([400, 401, 429, 500])('never retries HTTP %s and sanitizes failures', async (status) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ message: merchant.clientSecret + ' 9000000001' }, { status }),
      );
    await expect(new CashfreeHttpGateway(fetcher).create(merchant, input)).rejects.toThrow(
      'Payment provider is unavailable',
    );
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('returns null only for an unknown order, rejects redirects, malformed and oversized responses', async () => {
    expect(
      await new CashfreeHttpGateway(
        vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 404 })),
      ).order(merchant, input.providerOrderId),
    ).toBeNull();
    for (const response of [
      Response.json({}),
      new Response('x'.repeat(513000)),
      new Response(null, { status: 302 }),
    ]) {
      await expect(
        new CashfreeHttpGateway(vi.fn<typeof fetch>().mockResolvedValue(response)).order(
          merchant,
          input.providerOrderId,
        ),
      ).rejects.toThrow('Payment provider is unavailable');
    }
  });
  it('authenticates exact raw bytes and the timestamp, with constant-size signature checks', () => {
    const raw = Buffer.from('{"payment_amount": 123.00}'),
      timestamp = '1793800000000';
    const sign = createHmac('sha256', merchant.clientSecret)
      .update(timestamp)
      .update(raw)
      .digest('base64');
    expect(verifyCashfreeSignature(raw, timestamp, sign, merchant.clientSecret)).toBe(true);
    expect(
      verifyCashfreeSignature(
        Buffer.from('{"payment_amount":123}'),
        timestamp,
        sign,
        merchant.clientSecret,
      ),
    ).toBe(false);
    expect(verifyCashfreeSignature(raw, '1793800000001', sign, merchant.clientSecret)).toBe(false);
    expect(verifyCashfreeSignature(raw, timestamp, sign, 'another-synthetic-secret')).toBe(false);
    expect(verifyCashfreeSignature(raw, timestamp, 'bad', merchant.clientSecret)).toBe(false);
  });
  it('requires distinct clinic merchant accounts and signs pay-only links', () => {
    expect(Object.keys(parseMerchants(JSON.stringify({ [id]: merchant })))).toEqual([id]);
    expect(() =>
      parseMerchants(
        JSON.stringify({ [id]: merchant, '22345678-1234-4234-8234-123456789abc': merchant }),
      ),
    ).toThrow('distinct clinic accounts');
    const token = paymentToken(id, input.expiresAt, 'synthetic-link-secret-at-least-32');
    expect(paymentTokenId(token, 'synthetic-link-secret-at-least-32')).toBe(id);
    expect(
      paymentTokenId(
        token.replace(id, '22345678-1234-4234-8234-123456789abc'),
        'synthetic-link-secret-at-least-32',
      ),
    ).toBeNull();
    expect(paymentTokenId(token, 'different-secret')).toBeNull();
    expect(RecordPaymentBody.safeParse({ id, mode: 'cashfree', amountPaise: 100 }).success).toBe(
      false,
    );
  });
  it('converts exact decimal currency and rejects fractional paise or unsafe amounts', () => {
    expect(toPaise(123.45)).toBe(12345);
    expect(toPaise('1.00')).toBe(100);
    expect(toPaise(0.1)).toBe(10);
    for (const n of [1.001, NaN, Infinity, -1, '1e2', '9999999999999999999'])
      expect(() => toPaise(n)).toThrow();
  });
});

it('keeps collection disabled by default and validates enabled configuration without revealing credentials', () => {
  expect(loadConfig({}).CASHFREE_ENABLED).toBe(false);
  const env = {
    CASHFREE_ENABLED: 'true',
    CASHFREE_MERCHANTS_JSON: JSON.stringify({ [id]: merchant }),
    CASHFREE_LINK_SECRET: 'synthetic-payment-link-secret-at-least-32',
    CASHFREE_WEBHOOK_URL: 'https://api.test/v1/webhooks/cashfree',
    WEB_BASE_URL: 'https://portal.test',
  };
  expect(loadConfig(env).CASHFREE_ENABLED).toBe(true);
  expect(() => loadConfig({ ...env, WEB_BASE_URL: 'http://portal.test' })).toThrow();
  expect(() => loadConfig({ ...env, CASHFREE_MERCHANTS_JSON: 'bad-sensitive-token' })).toThrow();
  try {
    loadConfig({ ...env, CASHFREE_MERCHANTS_JSON: 'bad-sensitive-token' });
  } catch (e) {
    expect(String(e)).not.toContain('bad-sensitive-token');
  }
});

describe('Cashfree refund transport', () => {
  const remote = {
    order_id: input.providerOrderId,
    refund_id: 'rf' + id.replaceAll('-', ''),
    cf_refund_id: '9001',
    cf_payment_id: '8001',
    refund_amount: 123.45,
    refund_currency: 'INR',
    refund_status: 'PENDING',
    refund_type: 'MERCHANT_INITIATED',
  };
  it('uses the immutable UUID, exact amount and generic note, and accepts the documented one-element response', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json([remote]));
    const result = await new CashfreeHttpGateway(fetcher).createRefund(merchant, {
      id,
      orderId: input.providerOrderId,
      refundId: remote.refund_id,
      amountPaise: 12345,
    });
    expect(result.cf_refund_id).toBe('9001');
    const [url, options] = fetcher.mock.calls[0]!;
    expect(url).toBe(
      'https://sandbox.cashfree.com/pg/orders/' + input.providerOrderId + '/refunds',
    );
    expect(options?.headers).toMatchObject({
      'x-idempotency-key': id,
      'x-client-id': merchant.clientId,
      'x-api-version': '2026-01-01',
    });
    expect(JSON.parse(options!.body as string)).toEqual({
      refund_id: remote.refund_id,
      refund_amount: 123.45,
      refund_note: 'Clinic refund',
      refund_speed: 'STANDARD',
    });
    expect(options?.redirect).toBe('error');
  });
  it('does not retry ambiguous refund creation or retain provider details', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('PRIVATE-BANK-DATA'));
    const result = await new CashfreeHttpGateway(fetcher)
      .createRefund(merchant, {
        id,
        orderId: input.providerOrderId,
        refundId: remote.refund_id,
        amountPaise: 12345,
      })
      .catch((e: unknown) => e);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(String(result)).not.toContain('PRIVATE-BANK-DATA');
  });
  it('reads a specific refund and all order refunds using the original merchant and fixed production host', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(remote))
      .mockResolvedValueOnce(Response.json([remote]));
    const api = new CashfreeHttpGateway(fetcher),
      live = { ...merchant, environment: 'production' as const };
    expect((await api.refund(live, input.providerOrderId, remote.refund_id))!.refund_status).toBe(
      'PENDING',
    );
    expect(await api.refunds(live, input.providerOrderId)).toHaveLength(1);
    expect(String(fetcher.mock.calls[0]![0])).toBe(
      'https://api.cashfree.com/pg/orders/' +
        input.providerOrderId +
        '/refunds/' +
        remote.refund_id,
    );
  });
});
