import { Bill, type TokenResponse } from '@dhc/contracts';
import { withPayments, withTenant } from '@dhc/db';
import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ProviderRefund,
  type CreateRefundInput,
  type CreateOrderInput,
  type Merchant,
  type ProviderOrder,
  type ProviderPayment,
} from '../src/payments/cashfree';
import { bearer, createHarness, resetDatabase, seedTwoClinics, staffLogin } from './harness';
const h = createHarness();
let clinics: Awaited<ReturnType<typeof seedTwoClinics>>,
  doctor: TokenResponse,
  admin: TokenResponse,
  other: TokenResponse;
const merchant: Merchant = {
  clientId: 'synthetic-clinic-a',
  clientSecret: 'synthetic-clinic-a-secret-32-characters',
  environment: 'sandbox',
};
const remotes = new Map<string, ProviderOrder>(),
  transactions = new Map<string, ProviderPayment[]>();
const gateway = {
  create: vi.fn(async (_m: Merchant, input: CreateOrderInput): Promise<ProviderOrder> => {
    const prior = remotes.get(input.providerOrderId);
    if (prior) return prior;
    const value: ProviderOrder = {
      order_id: input.providerOrderId,
      order_amount: input.amountPaise / 100,
      order_currency: 'INR',
      order_status: 'ACTIVE',
      payment_session_id: 'synthetic-session-' + input.id,
    };
    remotes.set(input.providerOrderId, value);
    return value;
  }),
  order: vi.fn(async (_m: Merchant, id: string) => remotes.get(id) ?? null),
  payments: vi.fn(async (_m: Merchant, id: string) => transactions.get(id) ?? []),
  terminate: vi.fn(async (_m: Merchant, id: string) => {
    const row = remotes.get(id)!;
    if (row.order_status !== 'PAID') row.order_status = 'TERMINATED';
  }),
};
beforeEach(async () => {
  await resetDatabase(h.owner);
  h.clock.ms = Date.UTC(2026, 10, 4, 12);
  remotes.clear();
  transactions.clear();
  vi.clearAllMocks();
  clinics = await seedTwoClinics(h);
  doctor = await staffLogin(h, 'clinic-a', clinics.a.doctor);
  admin = await staffLogin(h, 'clinic-a', clinics.a.admin);
  other = await staffLogin(h, 'clinic-b', clinics.b.doctor);
  h.services.cashfree = {
    merchants: { [clinics.a.org.id]: merchant },
    gateway,
    linkSecret: 'synthetic-payment-link-secret-at-least-32',
    webBaseUrl: 'https://portal.test',
    notifyUrl: 'https://api.test/v1/webhooks/cashfree',
  };
  await h.owner.patient.update({
    where: { id: clinics.a.patients[0]!.id },
    data: { phone: '+919000000001' },
  });
});
afterAll(async () => {
  await h.app.close();
  await h.owner.$disconnect();
});
const call = (
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  tokens: TokenResponse | null = doctor,
  payload?: object,
) => h.app.inject({ method, url: '/v1' + path, headers: tokens ? bearer(tokens) : {}, payload });
async function bill() {
  const place = await h.owner.clinic.create({
    data: { organisationId: clinics.a.org.id, name: 'Synthetic clinic' },
  });
  const type = await h.owner.consultationType.create({
    data: {
      organisationId: clinics.a.org.id,
      name: 'Visit',
      mode: 'in_person',
      defaultDurationMin: 15,
      feePaise: 80000,
    },
  });
  const at = h.services.now();
  const visit = await h.owner.appointment.create({
    data: {
      organisationId: clinics.a.org.id,
      patientId: clinics.a.patients[0]!.id,
      doctorUserId: clinics.a.doctor.userId,
      clinicId: place.id,
      consultationTypeId: type.id,
      date: new Date('2026-11-04T00:00:00Z'),
      startAt: at,
      endAt: new Date(at.getTime() + 900000),
      status: 'checked_in',
      source: 'front_desk',
      tokenNumber: 1,
      createdByUserId: clinics.a.doctor.userId,
    },
  });
  const response = await call('PUT', `/appointments/${visit.id}/bill`, doctor, {
    revision: 0,
    consultation: 'consultation',
    items: [],
  });
  expect(response.statusCode, response.body).toBe(200);
  return Bill.parse(response.json());
}
async function create(b: Bill, id = randomUUID()) {
  const response = await call('POST', `/bills/${b.id}/online-payment`, doctor, { id });
  expect(response.statusCode, response.body).toBe(200);
  return response.json().order as { id: string; paymentUrl: string; status: string };
}
function success(
  providerOrderId: string,
  id = '1234567890123456789',
  amount = 800,
): ProviderPayment {
  return {
    order_id: providerOrderId,
    cf_payment_id: id,
    payment_amount: amount,
    payment_currency: 'INR',
    payment_status: 'SUCCESS',
    is_captured: true,
  };
}
async function webhook(
  orderId: string,
  payment: ProviderPayment,
  secret = merchant.clientSecret,
  type = 'PAYMENT_SUCCESS_WEBHOOK',
  orderAmount = 800,
) {
  const raw = JSON.stringify({
    type,
    data: {
      order: { order_id: orderId, order_amount: orderAmount, order_currency: 'INR' },
      payment,
      customer_details: { customer_phone: '9000000001', customer_name: 'PRIVATE-SYNTHETIC' },
      bank_details: { account: 'DO-NOT-STORE' },
    },
  });
  const timestamp = String(h.clock.ms),
    signature = createHmac('sha256', secret).update(timestamp).update(raw).digest('base64');
  return h.app.inject({
    method: 'POST',
    url: '/v1/webhooks/cashfree',
    payload: raw,
    headers: {
      'content-type': 'application/json',
      'x-webhook-timestamp': timestamp,
      'x-webhook-signature': signature,
    },
  });
}
const source = (order: { id: string }) => 'dhc_' + order.id.replaceAll('-', '');

const refundRemotes = new Map<string, ProviderRefund>();
let refundSerial = 0;
const refundGateway = {
  createRefund: vi.fn(async (_m: Merchant, input: CreateRefundInput): Promise<ProviderRefund> => {
    const key = input.orderId + ':' + input.refundId,
      prior = refundRemotes.get(key);
    if (prior) return prior;
    const value: ProviderRefund = {
      order_id: input.orderId,
      refund_id: input.refundId,
      cf_refund_id: String(9000 + ++refundSerial),
      cf_payment_id: '1234567890123456789',
      refund_amount: input.amountPaise / 100,
      refund_currency: 'INR',
      refund_status: 'PENDING',
      refund_type: 'MERCHANT_INITIATED',
    };
    refundRemotes.set(key, value);
    return value;
  }),
  refund: vi.fn(
    async (_m: Merchant, orderId: string, refundId: string) =>
      refundRemotes.get(orderId + ':' + refundId) ?? null,
  ),
  refunds: vi.fn(async (_m: Merchant, orderId: string) =>
    [...refundRemotes.values()].filter((r) => r.order_id === orderId),
  ),
};
beforeEach(() => {
  refundRemotes.clear();
  refundSerial = 0;
  h.services.cashfree!.refundGateway = refundGateway;
  h.services.cashfree!.refundsEnabled = true;
});
async function paidBill() {
  const b = await bill(),
    order = await create(b),
    providerId = source(order),
    p = success(providerId);
  expect((await webhook(providerId, p)).statusCode).toBe(200);
  remotes.get(providerId)!.order_status = 'PAID';
  transactions.set(providerId, [p]);
  const payment = await h.owner.payment.findFirstOrThrow({ where: { billId: b.id } });
  return { b, order, payment };
}
const requestRefund = (paymentId: string, amountPaise = 20000, id = randomUUID()) =>
  call('POST', `/payments/${paymentId}/refunds`, admin, {
    id,
    amountPaise,
    reason: 'service_cancelled',
  });
async function pending(paymentId: string, amountPaise = 20000) {
  const response = await requestRefund(paymentId, amountPaise);
  expect(response.statusCode, response.body).toBe(200);
  return h.owner.cashfreeRefund.findFirstOrThrow({ where: { paymentId, status: 'pending' } });
}
const remoteOf = (r: { orderId: string; merchantRefundId: string }) =>
  refundRemotes.get('dhc_' + r.orderId.replaceAll('-', '') + ':' + r.merchantRefundId)!;
async function refundCallback(remote: ProviderRefund, secret = merchant.clientSecret) {
  const raw = JSON.stringify({
    type: 'REFUND_STATUS_WEBHOOK',
    data: {
      refund: {
        ...remote,
        refund_note: 'PRIVATE-DO-NOT-STORE',
        refund_arn: 'PRIVATE-BANK-REFERENCE',
      },
      customer: { phone: '9000000001' },
    },
  });
  const timestamp = String(h.clock.ms),
    signature = createHmac('sha256', secret).update(timestamp).update(raw).digest('base64');
  return h.app.inject({
    method: 'POST',
    url: '/v1/webhooks/cashfree',
    payload: raw,
    headers: {
      'content-type': 'application/json',
      'x-webhook-timestamp': timestamp,
      'x-webhook-signature': signature,
    },
  });
}
describe('Cashfree refunds and append-only ledger', () => {
  it('requires a clinic admin, reserves partial funds and leaves the original receipt and bill unchanged', async () => {
    const { b, payment } = await paidBill();
    const denied = await call('POST', `/payments/${payment.id}/refunds`, doctor, {
      id: randomUUID(),
      amountPaise: 20000,
      reason: 'other',
    });
    expect(denied.statusCode).toBe(403);
    const receiptBefore = await call('GET', `/payments/${payment.id}/receipt`);
    const row = await pending(payment.id);
    expect(await h.owner.refundEntry.count()).toBe(0);
    expect((await call('GET', `/refunds/${row.id}/voucher`)).statusCode).toBe(404);
    expect((await requestRefund(payment.id, 10000)).statusCode).toBe(409);
    const remote = remoteOf(row);
    remote.refund_status = 'SUCCESS';
    expect((await refundCallback(remote)).statusCode).toBe(200);
    const entry = await h.owner.refundEntry.findUniqueOrThrow({ where: { refundId: row.id } });
    expect(entry).toMatchObject({ amountPaise: 20000, voucherNumber: 'RF00001' });
    const view = await call('GET', `/appointments/${b.appointmentId}/bill`);
    expect(view.json().bill).toMatchObject({
      paidPaise: 80000,
      refundedPaise: 20000,
      netCollectedPaise: 60000,
      balancePaise: 0,
      status: 'paid',
    });
    expect(view.json().canPay).toBe(false);
    expect((await call('GET', `/payments/${payment.id}/receipt`)).body).toBe(receiptBefore.body);
    const voucher = await call('GET', `/refunds/${row.id}/voucher`);
    expect(voucher.statusCode, voucher.body).toBe(200);
    expect(voucher.json().refund).toMatchObject({
      voucherNumber: 'RF00001',
      amountPaise: 20000,
      providerReference: remote.cf_refund_id,
    });
    expect((await call('GET', `/refunds/${row.id}/voucher`, other)).statusCode).toBe(404);
  });
  it('authenticates raw callbacks, posts once and ignores pending/failure after success', async () => {
    const { payment } = await paidBill(),
      row = await pending(payment.id),
      remote = remoteOf(row);
    remote.refund_status = 'SUCCESS';
    expect((await refundCallback(remote, 'wrong-merchant-secret')).statusCode).toBe(401);
    expect(await h.owner.refundEntry.count()).toBe(0);
    const responses = await Promise.all([refundCallback(remote), refundCallback(remote)]);
    responses.forEach((r) => expect(r.statusCode, r.body).toBe(200));
    remote.refund_status = 'CANCELLED';
    expect((await refundCallback(remote)).statusCode).toBe(200);
    expect(await h.owner.refundEntry.count()).toBe(1);
    expect((await h.owner.cashfreeRefund.findUniqueOrThrow({ where: { id: row.id } })).status).toBe(
      'succeeded',
    );
    expect(JSON.stringify(await h.owner.cashfreeRefundEvent.findMany())).not.toMatch(
      /PRIVATE|9000000001|refund_note|refund_arn/,
    );
  });
  it('recovers a lost accepted response using the same refund identity without another create', async () => {
    const { payment } = await paidBill(),
      original = refundGateway.createRefund.getMockImplementation()!;
    refundGateway.createRefund.mockImplementationOnce(async (m, input) => {
      await original(m, input);
      throw new Error('sensitive response');
    });
    const result = await requestRefund(payment.id);
    expect(result.statusCode, result.body).toBe(503);
    expect(result.body).not.toContain('sensitive');
    const row = await h.owner.cashfreeRefund.findFirstOrThrow();
    expect(row.status).toBe('creating');
    expect((await requestRefund(payment.id)).statusCode).toBe(409);
    const recovered = await call('POST', `/refunds/${row.id}/retry`, admin);
    expect(recovered.statusCode, recovered.body).toBe(200);
    expect(refundGateway.createRefund).toHaveBeenCalledOnce();
    expect(await h.owner.cashfreeRefund.count()).toBe(1);
  });
  it('keeps an unaccepted timeout reserved, check never submits, and explicit retry uses the original key', async () => {
    const { payment } = await paidBill();
    refundGateway.createRefund.mockRejectedValueOnce(new Error('network timeout'));
    expect((await requestRefund(payment.id)).statusCode).toBe(503);
    const row = await h.owner.cashfreeRefund.findFirstOrThrow();
    expect((await call('POST', `/refunds/${row.id}/check`, admin)).statusCode).toBe(409);
    expect(refundGateway.createRefund).toHaveBeenCalledOnce();
    expect((await call('POST', `/refunds/${row.id}/retry`, admin)).statusCode).toBe(200);
    expect(refundGateway.createRefund.mock.calls.map((c) => c[1].id)).toEqual([row.id, row.id]);
  });
  it('bounds partial refunds across concurrent requests and supports a subsequent confirmed partial refund', async () => {
    const { payment } = await paidBill();
    expect((await requestRefund(payment.id, 80001)).statusCode).toBe(409);
    const responses = await Promise.all([
      requestRefund(payment.id, 50000),
      requestRefund(payment.id, 50000),
    ]);
    expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const row = await h.owner.cashfreeRefund.findFirstOrThrow();
    const remote = remoteOf(row);
    remote.refund_status = 'SUCCESS';
    await refundCallback(remote);
    expect((await requestRefund(payment.id, 30001)).statusCode).toBe(409);
    const next = await pending(payment.id, 30000),
      second = remoteOf(next);
    second.refund_status = 'SUCCESS';
    expect((await refundCallback(second)).statusCode).toBe(200);
    expect(
      (await h.owner.refundEntry.aggregate({ _sum: { amountPaise: true } }))._sum.amountPaise,
    ).toBe(80000);
    expect((await requestRefund(payment.id, 1)).statusCode).toBe(409);
  });
  it.each(['CANCELLED', 'REJECTED'] as const)(
    'releases capacity only on a verified %s and ignores older pending states',
    async (status) => {
      const { payment } = await paidBill(),
        row = await pending(payment.id, 80000),
        remote = remoteOf(row);
      remote.refund_status = status;
      expect((await refundCallback(remote)).statusCode).toBe(200);
      remote.refund_status = 'PENDING';
      await refundCallback(remote);
      expect(
        (await h.owner.cashfreeRefund.findUniqueOrThrow({ where: { id: row.id } })).status,
      ).toBe(status.toLowerCase());
      expect((await requestRefund(payment.id, 80000)).statusCode).toBe(200);
      expect(await h.owner.refundEntry.count()).toBe(0);
    },
  );
  it.each(['amount', 'currency', 'payment', 'reference'] as const)(
    'holds a mismatched %s without posting money',
    async (kind) => {
      const { payment } = await paidBill(),
        row = await pending(payment.id),
        remote = { ...remoteOf(row), refund_status: 'SUCCESS' as const };
      if (kind === 'amount') remote.refund_amount = 199;
      if (kind === 'currency') remote.refund_currency = 'USD';
      if (kind === 'payment') remote.cf_payment_id = '999';
      if (kind === 'reference') remote.cf_refund_id = '999';
      if (kind === 'reference') {
        const saved = await call('POST', `/refunds/${row.id}/check`, admin);
        expect(saved.statusCode).toBe(200);
      }
      const response = await refundCallback(remote);
      expect(response.statusCode, response.body).toBe(200);
      expect(await h.owner.refundEntry.count()).toBe(0);
      expect(
        (await h.owner.cashfreeOrder.findUniqueOrThrow({ where: { id: row.orderId } }))
          .refundReviewRequired,
      ).toBe(true);
    },
  );
  it('imports verified dashboard refunds before allowing another request', async () => {
    const { payment, order } = await paidBill();
    const remote: ProviderRefund = {
      order_id: source(order),
      refund_id: 'dashboard-refund',
      cf_refund_id: '98765',
      cf_payment_id: payment.reference!,
      refund_amount: 300,
      refund_currency: 'INR',
      refund_status: 'SUCCESS',
      refund_type: 'MERCHANT_INITIATED',
    };
    refundRemotes.set(source(order) + ':dashboard-refund', remote);
    const rejected = await requestRefund(payment.id, 60000);
    expect(rejected.statusCode, rejected.body).toBe(409);
    const imported = await h.owner.cashfreeRefund.findFirstOrThrow();
    expect(imported).toMatchObject({
      origin: 'provider',
      amountPaise: 30000,
      status: 'succeeded',
      requestedByUserId: null,
    });
    expect(await h.owner.refundEntry.count()).toBe(1);
    expect((await requestRefund(payment.id, 50000)).statusCode).toBe(200);
  });
  it('flags an external refund for an unrelated payment without attributing it to this receipt', async () => {
    const { order } = await paidBill();
    const remote: ProviderRefund = {
      order_id: source(order),
      refund_id: 'external-other-payment',
      cf_refund_id: '8765',
      cf_payment_id: '999',
      refund_amount: 100,
      refund_currency: 'INR',
      refund_status: 'SUCCESS',
      refund_type: 'UNRECONCILED_AUTO_REFUND',
    };
    expect((await refundCallback(remote)).statusCode).toBe(200);
    expect(await h.owner.refundEntry.count()).toBe(0);
    expect(await h.owner.cashfreeRefund.count()).toBe(0);
    expect(
      (await h.owner.cashfreeOrder.findUniqueOrThrow({ where: { id: order.id } }))
        .refundReviewRequired,
    ).toBe(true);
  });
  it('can pause new refunds while retaining callback confirmation and check controls', async () => {
    const { payment } = await paidBill(),
      row = await pending(payment.id);
    h.services.cashfree!.refundsEnabled = false;
    expect((await requestRefund(payment.id)).statusCode).toBe(409);
    expect((await call('POST', `/refunds/${row.id}/retry`, admin)).statusCode).toBe(409);
    const remote = remoteOf(row);
    remote.refund_status = 'SUCCESS';
    expect((await refundCallback(remote)).statusCode).toBe(200);
    expect((await call('POST', `/refunds/${row.id}/check`, admin)).statusCode).toBe(200);
    expect(await h.owner.refundEntry.count()).toBe(1);
  });
  it('preserves tenant isolation, immutable requests, and a ledger entry for every committed success', async () => {
    const { payment } = await paidBill(),
      row = await pending(payment.id);
    expect(
      await withTenant(h.services.db, clinics.b.org.id, (tx) => tx.cashfreeRefund.findMany()),
    ).toEqual([]);
    await expect(
      withTenant(h.services.db, clinics.a.org.id, (tx) =>
        tx.cashfreeRefund.update({ where: { id: row.id }, data: { amountPaise: 1 } }),
      ),
    ).rejects.toThrow();
    await expect(
      withPayments(h.services.db, clinics.a.org.id, (tx) =>
        tx.cashfreeRefund.update({ where: { id: row.id }, data: { amountPaise: 1 } }),
      ),
    ).rejects.toThrow();
    await expect(
      withPayments(h.services.db, clinics.a.org.id, (tx) =>
        tx.cashfreeRefund.update({ where: { id: row.id }, data: { status: 'succeeded' } }),
      ),
    ).rejects.toThrow();
    const remote = remoteOf(row);
    remote.refund_status = 'SUCCESS';
    await refundCallback(remote);
    await expect(
      withPayments(h.services.db, clinics.a.org.id, (tx) =>
        tx.refundEntry.delete({ where: { refundId: row.id } }),
      ),
    ).rejects.toThrow();
  });
  it('includes Cashfree gross collections, posted refunds and net collections on the proper day', async () => {
    const { payment, b } = await paidBill(),
      row = await pending(payment.id),
      remote = remoteOf(row);
    remote.refund_status = 'SUCCESS';
    await refundCallback(remote);
    const response = await call('GET', '/collections?date=2026-11-04', admin);
    expect(response.statusCode, response.body).toBe(200);
    const report = response.json();
    expect(report).toMatchObject({ totalPaise: 80000, refundedPaise: 20000, netPaise: 60000 });
    expect(report.byMode.find((m: { mode: string }) => m.mode === 'cashfree').amountPaise).toBe(
      80000,
    );
    expect(report.refunds[0]).toMatchObject({
      amountPaise: 20000,
      appointmentId: b.appointmentId,
      voucherNumber: 'RF00001',
    });
  });
  it('posts only once when a refund check and callback arrive together', async () => {
    const { payment } = await paidBill(),
      row = await pending(payment.id),
      remote = remoteOf(row);
    remote.refund_status = 'SUCCESS';
    const responses = await Promise.all([
      call('POST', `/refunds/${row.id}/check`, admin),
      refundCallback(remote),
    ]);
    responses.forEach((r) => expect(r.statusCode, r.body).toBe(200));
    expect(await h.owner.refundEntry.count()).toBe(1);
  });
});

it('reports a refund-only day as negative net collections without reopening the original bill', async () => {
  const { payment } = await paidBill();
  h.clock.advance(86400);
  admin = await staffLogin(h, 'clinic-a', clinics.a.admin);
  const row = await pending(payment.id),
    remote = remoteOf(row);
  remote.refund_status = 'SUCCESS';
  expect((await refundCallback(remote)).statusCode).toBe(200);
  const response = await call('GET', '/collections?date=2026-11-05', admin);
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json()).toMatchObject({ totalPaise: 0, refundedPaise: 20000, netPaise: -20000 });
});

it('holds an excessive external confirmed total for review instead of over-posting the receipt', async () => {
  const { payment, order } = await paidBill();
  const base: ProviderRefund = {
    order_id: source(order),
    refund_id: 'external-first',
    cf_refund_id: '98760',
    cf_payment_id: payment.reference!,
    refund_amount: 700,
    refund_currency: 'INR',
    refund_status: 'SUCCESS',
    refund_type: 'MERCHANT_INITIATED',
  };
  expect((await refundCallback(base)).statusCode).toBe(200);
  expect(
    (
      await refundCallback({
        ...base,
        refund_id: 'external-second',
        cf_refund_id: '98761',
        refund_amount: 200,
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (await h.owner.refundEntry.aggregate({ _sum: { amountPaise: true } }))._sum.amountPaise,
  ).toBe(70000);
  expect(
    (await h.owner.cashfreeOrder.findUniqueOrThrow({ where: { id: order.id } }))
      .refundReviewRequired,
  ).toBe(true);
});
