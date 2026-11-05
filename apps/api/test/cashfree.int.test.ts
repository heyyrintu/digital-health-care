import { Bill, type TokenResponse } from '@dhc/contracts';
import { withTenant } from '@dhc/db';
import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
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
const cash = (b: Bill, amountPaise = 80000) =>
  call('POST', `/bills/${b.id}/payments`, doctor, { id: randomUUID(), mode: 'cash', amountPaise });
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
const token = (order: { paymentUrl: string }) =>
  new URL(order.paymentUrl).pathname.split('/').at(-1)!;
describe('Cashfree bill collection', () => {
  it('reserves the server-priced balance, encrypts sessions, hides patient data and prevents counter edits', async () => {
    const b = await bill(),
      order = await create(b),
      row = await h.owner.cashfreeOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.amountPaise).toBe(80000);
    expect(row.sessionCipher).not.toContain('synthetic-session');
    expect(row.requestCipher).not.toContain('9000000001');
    expect(gateway.create.mock.calls[0]![1]).toMatchObject({
      amountPaise: 80000,
      id: order.id,
      phone: '+919000000001',
    });
    const view = await call('GET', `/appointments/${b.appointmentId}/bill`);
    expect(view.json()).toMatchObject({ canEdit: false, canPay: false });
    expect((await cash(b)).statusCode).toBe(409);
    expect(
      (
        await call('PUT', `/appointments/${b.appointmentId}/bill`, doctor, {
          revision: b.revision,
          consultation: 'consultation',
          items: [],
        })
      ).statusCode,
    ).toBe(409);
    const info = await call('GET', `/public/payments/${token(order)}`, null);
    expect(info.statusCode, info.body).toBe(200);
    expect(info.body).not.toMatch(/9000000001|patient|billId|session|PRIVATE/);
    const checkout = await call('POST', `/public/payments/${token(order)}/checkout`, null);
    expect(checkout.statusCode, checkout.body).toBe(200);
    expect(checkout.json()).toMatchObject({
      environment: 'sandbox',
      paymentSessionId: 'synthetic-session-' + order.id,
    });
    expect((await call('GET', `/bills/${b.id}/online-payment`, other)).statusCode).toBe(404);
    expect(
      (await call('POST', `/bills/${b.id}/online-payment`, admin, { id: randomUUID() })).statusCode,
    ).toBe(403);
    expect((await call('GET', `/public/payments/${token(order)}x`, null)).statusCode).toBe(404);
  });
  it('accepts only a verified clinic callback, applies one receipt and never regresses on repeats or failures', async () => {
    const b = await bill(),
      order = await create(b),
      p = success(source(order));
    expect((await webhook(source(order), p, 'other-clinic-secret')).statusCode).toBe(401);
    expect(await h.owner.payment.count()).toBe(0);
    const responses = await Promise.all([webhook(source(order), p), webhook(source(order), p)]);
    responses.forEach((r) => expect(r.statusCode, r.body).toBe(200));
    expect(
      (
        await webhook(
          source(order),
          { ...p, payment_status: 'FAILED' },
          merchant.clientSecret,
          'PAYMENT_FAILED_WEBHOOK',
        )
      ).statusCode,
    ).toBe(200);
    expect(await h.owner.payment.count()).toBe(1);
    const payment = await h.owner.payment.findFirstOrThrow();
    expect(payment).toMatchObject({
      mode: 'cashfree',
      amountPaise: 80000,
      reference: p.cf_payment_id,
      receiptNumber: 'R00001',
    });
    expect(await h.owner.bill.findUniqueOrThrow({ where: { id: b.id } })).toMatchObject({
      status: 'paid',
      paidPaise: 80000,
    });
    const receipt = await call('GET', `/payments/${payment.id}/receipt`);
    expect(receipt.statusCode, receipt.body).toBe(200);
    expect(receipt.json().payment.receivedByName).toBeNull();
    const events = await h.owner.cashfreeEvent.findMany();
    expect(events).toHaveLength(2);
    expect(JSON.stringify(events)).not.toMatch(
      /PRIVATE|DO-NOT-STORE|9000000001|customer|bank_details/,
    );
  });
  it.each(['amount', 'currency', 'source'] as const)(
    'holds a mismatched %s for review without credit',
    async (kind) => {
      const b = await bill(),
        order = await create(b),
        p = success(source(order));
      if (kind === 'amount') p.payment_amount = 799;
      if (kind === 'currency') p.payment_currency = 'USD';
      const r = await webhook(
        source(order),
        p,
        merchant.clientSecret,
        'PAYMENT_SUCCESS_WEBHOOK',
        kind === 'source' ? 799 : 800,
      );
      expect(r.statusCode, r.body).toBe(200);
      expect(await h.owner.payment.count()).toBe(0);
      expect(
        (await h.owner.cashfreeOrder.findUniqueOrThrow({ where: { id: order.id } })).status,
      ).toBe('review');
    },
  );
  it('recovers an accepted creation timeout using the same immutable intent and order ID', async () => {
    const b = await bill();
    const original = gateway.create.getMockImplementation()!;
    gateway.create.mockImplementationOnce(async (m, input) => {
      await original(m, input);
      throw new Error('sensitive provider response');
    });
    const first = await call('POST', `/bills/${b.id}/online-payment`, doctor, { id: randomUUID() });
    expect(first.statusCode, first.body).toBe(503);
    expect(first.body).not.toContain('sensitive');
    const row = await h.owner.cashfreeOrder.findFirstOrThrow();
    expect(row.status).toBe('creating');
    expect((await cash(b)).statusCode).toBe(409);
    const recovered = await create(b);
    expect(recovered.id).toBe(row.id);
    expect(recovered.status).toBe('active');
    expect(gateway.create).toHaveBeenCalledOnce();
    expect(await h.owner.cashfreeOrder.count()).toBe(1);
  });
  it('serializes competing link requests and counter payments', async () => {
    const b = await bill();
    const responses = await Promise.all([
      call('POST', `/bills/${b.id}/online-payment`, doctor, { id: randomUUID() }),
      cash(b),
    ]);
    expect(responses.filter((r) => r.statusCode === 409)).toHaveLength(1);
    responses.forEach((r) => expect([200, 201, 409], r.body).toContain(r.statusCode));
    expect((await h.owner.payment.count()) + (await h.owner.cashfreeOrder.count())).toBe(1);
  });
  it('uses server status on return and does not trust browser success parameters', async () => {
    const b = await bill(),
      order = await create(b);
    const first = await call('POST', `/public/payments/${token(order)}/check?status=paid`, null);
    expect(first.json().status).toBe('active');
    expect(await h.owner.payment.count()).toBe(0);
    remotes.get(source(order))!.order_status = 'PAID';
    transactions.set(source(order), [success(source(order))]);
    h.clock.advance(6);
    const result = await call('POST', `/public/payments/${token(order)}/check`, null);
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json().status).toBe('paid');
    expect(await h.owner.payment.count()).toBe(1);
  });
  it('keeps termination requests locked until the provider confirms closure and checks for successful races', async () => {
    const b = await bill(),
      order = await create(b);
    gateway.terminate.mockImplementationOnce(async () => {
      remotes.get(source(order))!.order_status = 'TERMINATION_REQUESTED';
    });
    const pending = await call('POST', `/online-payments/${order.id}/close`);
    expect(pending.statusCode, pending.body).toBe(200);
    expect(pending.json().order.status).toBe('closing');
    expect((await cash(b)).statusCode).toBe(409);
    expect((await call('POST', `/public/payments/${token(order)}/checkout`, null)).statusCode).toBe(
      409,
    );
    const closed = await call('POST', `/online-payments/${order.id}/close`);
    expect(closed.json().order.status).toBe('terminated');
    expect((await cash(b)).statusCode).toBe(201);
    expect((await webhook(source(order), success(source(order)))).statusCode).toBe(200);
    expect(await h.owner.payment.count()).toBe(1);
    expect(
      (await h.owner.cashfreeOrder.findUniqueOrThrow({ where: { id: order.id } })).status,
    ).toBe('review');
  });
  it('does not release a locally expired link without provider confirmation', async () => {
    const b = await bill(),
      order = await create(b);
    h.clock.advance(31 * 60);
    const refreshed = await staffLogin(h, 'clinic-a', clinics.a.doctor);
    expect((await call('POST', `/public/payments/${token(order)}/checkout`, null)).statusCode).toBe(
      409,
    );
    expect(
      (
        await call('POST', `/bills/${b.id}/payments`, refreshed, {
          id: randomUUID(),
          mode: 'cash',
          amountPaise: 80000,
        })
      ).statusCode,
    ).toBe(409);
    remotes.get(source(order))!.order_status = 'EXPIRED';
    const r = await call('POST', `/online-payments/${order.id}/check`, refreshed);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().order.status).toBe('expired');
  });
  it('rejects forged online counter payments and database writes from the application role', async () => {
    const b = await bill(),
      order = await create(b);
    expect(
      (
        await call('POST', `/bills/${b.id}/payments`, doctor, {
          id: randomUUID(),
          mode: 'cashfree',
          amountPaise: 80000,
        })
      ).statusCode,
    ).toBe(400);
    await expect(
      withTenant(h.services.db, clinics.a.org.id, (tx) =>
        tx.payment.create({
          data: {
            id: randomUUID(),
            organisationId: clinics.a.org.id,
            billId: b.id,
            cashfreeOrderId: order.id,
            mode: 'cashfree',
            amountPaise: 80000,
            reference: '123',
            receiptNumber: 'FORGED',
            receivedByUserId: clinics.a.doctor.userId,
          },
        }),
      ),
    ).rejects.toThrow();
  });
});

it('can pause new checkout while continuing to verify payments already in flight', async () => {
  const b = await bill(),
    order = await create(b);
  h.services.cashfree!.acceptNewPayments = false;
  const next = await call('POST', `/bills/${b.id}/online-payment`, doctor, { id: randomUUID() });
  expect(next.statusCode).toBe(409);
  expect((await call('POST', `/public/payments/${token(order)}/checkout`, null)).statusCode).toBe(
    409,
  );
  const info = await call('GET', `/public/payments/${token(order)}`, null);
  expect(info.json().canPay).toBe(false);
  expect((await webhook(source(order), success(source(order)))).statusCode).toBe(200);
  expect(await h.owner.payment.count()).toBe(1);
});
it('preserves receipt numbering when the online payment collects a partially paid balance', async () => {
  const b = await bill();
  expect((await cash(b, 10000)).statusCode).toBe(201);
  const order = await create(b),
    row = await h.owner.cashfreeOrder.findUniqueOrThrow({ where: { id: order.id } });
  expect(row.amountPaise).toBe(70000);
  expect(
    (
      await webhook(
        source(order),
        success(source(order), '123', 700),
        merchant.clientSecret,
        'PAYMENT_SUCCESS_WEBHOOK',
        700,
      )
    ).statusCode,
  ).toBe(200);
  const payments = await h.owner.payment.findMany({ orderBy: { receiptNumber: 'asc' } });
  expect(payments.map((p) => [p.receiptNumber, p.amountPaise])).toEqual([
    ['R00001', 10000],
    ['R00002', 70000],
  ]);
});
it('reuses one order for concurrent creation requests and flags additional successful transactions for review', async () => {
  const b = await bill();
  const [one, two] = await Promise.all([create(b), create(b)]);
  expect(one.id).toBe(two.id);
  expect(await h.owner.cashfreeOrder.count()).toBe(1);
  expect((await webhook(source(one), success(source(one), '111'))).statusCode).toBe(200);
  expect((await webhook(source(one), success(source(one), '222'))).statusCode).toBe(200);
  expect(await h.owner.payment.count()).toBe(1);
  const view = await call('GET', `/bills/${b.id}/online-payment`);
  expect(view.json().order.reviewRequired).toBe(true);
});

it('serializes a return-status check with an arriving callback and credits only once', async () => {
  const b = await bill(),
    order = await create(b);
  h.clock.advance(6);
  remotes.get(source(order))!.order_status = 'PAID';
  transactions.set(source(order), [success(source(order))]);
  const responses = await Promise.all([
    call('POST', `/public/payments/${token(order)}/check`, null),
    webhook(source(order), success(source(order))),
  ]);
  responses.forEach((r) => expect(r.statusCode, r.body).toBe(200));
  expect(await h.owner.payment.count()).toBe(1);
  expect((await h.owner.bill.findUniqueOrThrow({ where: { id: b.id } })).paidPaise).toBe(80000);
});
