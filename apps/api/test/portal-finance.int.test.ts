import { createFinanceLinkToken, createRecordLinkToken } from '@dhc/secure-links';
import { CURRENT_CONSENT_VERSIONS, Bill, type TokenResponse } from '@dhc/contracts';
import { withTenant, withMessaging } from '@dhc/db';
import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type CreateOrderInput,
  type Merchant,
  type ProviderOrder,
  type ProviderPayment,
} from '../src/payments/cashfree';
import {
  bearer,
  createHarness,
  resetDatabase,
  seedTwoClinics,
  staffLogin,
  patientLogin,
} from './harness';
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
  h.clock.ms = Date.now();
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
async function bill(patientId = clinics.a.patients[0]!.id) {
  const place = await h.owner.clinic.create({
    data: { organisationId: clinics.a.org.id, name: 'Synthetic clinic ' + randomUUID() },
  });
  const type = await h.owner.consultationType.create({
    data: {
      organisationId: clinics.a.org.id,
      name: 'Visit ' + randomUUID(),
      mode: 'in_person',
      defaultDurationMin: 15,
      feePaise: 80000,
    },
  });
  const at = h.services.now();
  const visit = await h.owner.appointment.create({
    data: {
      organisationId: clinics.a.org.id,
      patientId,
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

let patient: TokenResponse, stranger: TokenResponse, foreign: TokenResponse;
beforeEach(async () => {
  patient = await patientLogin(h, 'clinic-a', '9000000001');
  stranger = await patientLogin(h, 'clinic-a', '9000000099');
  foreign = await patientLogin(h, 'clinic-b', '9000000098');
  const accept = Object.entries(CURRENT_CONSENT_VERSIONS).map(([kind, version]) => ({
    kind,
    version,
  }));
  for (const p of [patient, stranger, foreign])
    expect((await call('POST', '/portal/consents', p, { accept })).statusCode).toBe(200);
  h.services.paymentMessagingSender = '1234';
  h.services.paymentLinkSecret = 'synthetic-finance-link-secret-at-least-32';
});
const pref = (enabled = true) =>
  call('PUT', '/portal/whatsapp-payment-preference', patient, {
    enabled,
    recipientAgreed: enabled,
  });
const begin = (id: string) =>
  withMessaging(
    h.services.db,
    (tx) =>
      tx.$queryRaw<
        { phone: string; organisation_slug: string; link_expires_at: Date }[]
      >`SELECT * FROM messaging_begin_payment_notice(${id}::uuid,'1234')`,
  );
async function posted() {
  const b = await bill(),
    order = await create(b),
    p = success(source(order));
  expect((await webhook(source(order), p)).statusCode).toBe(200);
  remotes.get(source(order))!.order_status = 'PAID';
  transactions.set(source(order), [p]);
  const receipt = await h.owner.payment.findFirstOrThrow({ where: { billId: b.id } });
  return { b, order, receipt };
}
describe('patient finance and opted-in notices', () => {
  it('lists only owned bills/receipts, paginates within family and rejects foreign records/cursors', async () => {
    const { b, receipt } = await posted();
    const list = await call('GET', '/portal/bills', patient);
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().data).toContainEqual(
      expect.objectContaining({ id: b.id, paidPaise: 80000, balancePaise: 0, canPay: false }),
    );
    expect((await call('GET', '/portal/receipts', patient)).json().data[0].id).toBe(receipt.id);
    for (const path of [
      `/portal/bills/${b.id}`,
      `/portal/receipts/${receipt.id}`,
      `/portal/bills?cursor=${b.id}`,
      `/portal/receipts?cursor=${receipt.id}`,
    ])
      for (const actor of [stranger, foreign])
        expect((await call('GET', path, actor)).statusCode).toBe(404);
    expect((await call('GET', '/portal/bills', other)).statusCode).toBe(403);
    expect(
      (await call('POST', `/portal/bills/${b.id}/checkout`, stranger, { id: randomUUID() }))
        .statusCode,
    ).toBe(404);
    const detail = await call('GET', `/portal/receipts/${receipt.id}`, patient);
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.headers['cache-control']).toBe('no-store');
    expect(detail.json()).toMatchObject({
      payment: { id: receipt.id, amountPaise: 80000 },
      paidToDatePaise: 80000,
      balanceAfterPaise: 0,
    });
    await call('POST', '/portal/consents/health_data/withdraw', patient);
    expect((await call('GET', `/portal/receipts/${receipt.id}`, patient)).statusCode).toBe(403);
  });
  it('prepares/retries only the original server-priced balance, including dependant payments', async () => {
    const b = await bill(),
      id = randomUUID();
    expect(
      (await call('POST', `/portal/bills/${b.id}/checkout`, patient, { id, amountPaise: 1 }))
        .statusCode,
    ).toBe(400);
    const first = await call('POST', `/portal/bills/${b.id}/checkout`, patient, { id });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().order.paymentUrl).toMatch(/^https:\/\/portal.test\/pay\//);
    const again = await call('POST', `/portal/bills/${b.id}/checkout`, patient, {
      id: randomUUID(),
    });
    expect(again.json().order.id).toBe(id);
    expect(await h.owner.cashfreeOrder.count()).toBe(1);
    const child = await h.owner.patient.create({
      data: {
        organisationId: clinics.a.org.id,
        uhid: 'FIN-CHILD',
        name: 'Synthetic child',
        guardianPatientId: clinics.a.patients[0]!.id,
      },
    });
    const childBill = await bill(child.id);
    const childPay = await call('POST', `/portal/bills/${childBill.id}/checkout`, patient, {
      id: randomUUID(),
    });
    expect(childPay.statusCode, childPay.body).toBe(200);
    expect(gateway.create.mock.calls.at(-1)?.[1].phone).toBe('+919000000001');
    expect(
      (await call('GET', '/portal/receipts?patientId=' + clinics.b.patients[0]!.id, patient))
        .statusCode,
    ).toBe(404);
  });
  it('normalizes checkout UUID casing and keeps pending/unknown amounts out of receipts', async () => {
    const b = await bill(),
      id = randomUUID().toUpperCase();
    const r = await call('POST', `/portal/bills/${b.id}/checkout`, patient, { id });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().order.id).toBe(id.toLowerCase());
    expect(remotes.has('dhc_' + id.toLowerCase().replaceAll('-', ''))).toBe(true);
    expect((await call('GET', '/portal/receipts', patient)).json().data).toEqual([]);
  });
  it('does not enqueue without separate consent, deduplicates notices, rechecks source state and resolves authenticated links', async () => {
    h.services.appointmentMessagingSender = '1234';
    expect(
      (
        await call('PUT', '/portal/whatsapp-preference', patient, {
          enabled: true,
          recipientAgreed: true,
        })
      ).statusCode,
    ).toBe(200);
    const b = await bill();
    await create(b);
    expect(await h.owner.whatsAppDelivery.count({ where: { kind: 'payment_link' } })).toBe(0);
    await pref();
    const next = await bill(),
      order = await create(next);
    const d = await h.owner.whatsAppDelivery.findFirstOrThrow({
      where: { financialOrderId: order.id },
    });
    expect(
      await withTenant(h.services.db, clinics.b.org.id, (tx) => tx.whatsAppDelivery.count()),
    ).toBe(0);
    const [n] = await begin(d.id);
    expect(n?.phone).toBe('+919000000001');
    expect(await begin(d.id)).toEqual([]);
    const token = createFinanceLinkToken(d.id, n!.link_expires_at, h.services.paymentLinkSecret!);
    expect((await call('GET', '/portal/finance-links/' + token, patient)).json()).toMatchObject({
      kind: 'payment_link',
      sourceId: next.id,
    });
    expect((await call('GET', '/portal/finance-links/' + token, stranger)).statusCode).toBe(404);
    expect(
      (
        await call(
          'GET',
          '/portal/finance-links/' +
            createRecordLinkToken(d.id, n!.link_expires_at, h.services.paymentLinkSecret!),
          patient,
        )
      ).statusCode,
    ).toBe(404);
    expect((await webhook(source(order), success(source(order)))).statusCode).toBe(200);
    expect((await call('GET', '/portal/finance-links/' + token, patient)).statusCode).toBe(404);
    const receipt = await h.owner.payment.findFirstOrThrow({ where: { billId: next.id } }),
      notice = await h.owner.whatsAppDelivery.findFirstOrThrow({
        where: { receiptPaymentId: receipt.id },
      });
    await webhook(source(order), success(source(order)));
    expect(await h.owner.whatsAppDelivery.count({ where: { receiptPaymentId: receipt.id } })).toBe(
      1,
    );
    const [r] = await begin(notice.id),
      receiptToken = createFinanceLinkToken(
        notice.id,
        r!.link_expires_at,
        h.services.paymentLinkSecret!,
      );
    expect(
      (await call('GET', '/portal/finance-links/' + receiptToken, patient)).json(),
    ).toMatchObject({ kind: 'receipt_ready', sourceId: receipt.id, paymentUrl: null });
  });
  it('suppresses queued notices after STOP, number/consent changes, payment and expiry', async () => {
    await pref();
    const { order } = await posted();
    const receiptNotice = await h.owner.whatsAppDelivery.findFirstOrThrow({
      where: { kind: 'receipt_ready' },
    });
    const unpaid = await create(await bill()),
      queued = await h.owner.whatsAppDelivery.findFirstOrThrow({
        where: { financialOrderId: unpaid.id },
      });
    await withMessaging(
      h.services.db,
      (tx) =>
        tx.$executeRaw`SELECT messaging_opt_out_phone(${'a'.repeat(64)},'1234','+919000000001',${h.services.now()})`,
    );
    expect(await begin(queued.id)).toEqual([]);
    expect(await begin(receiptNotice.id)).toEqual([]);
    expect((await call('GET', '/portal/whatsapp-payment-preference', patient)).json().enabled).toBe(
      false,
    );
    await pref();
    const expired = await create(await bill());
    const ed = await h.owner.whatsAppDelivery.findFirstOrThrow({
      where: { financialOrderId: expired.id },
    });
    await h.owner.whatsAppDelivery.update({
      where: { id: ed.id },
      data: { expiresAt: new Date(0) },
    });
    expect(await begin(ed.id)).toEqual([]);
    expect(await h.owner.payment.count()).toBe(1);
    expect(order.id).toBeTruthy();
  });
  it('skips paid or moved-recipient notices before sending and never retries an uncertain attempt', async () => {
    await pref();
    const { order } = await posted();
    const stale = await h.owner.whatsAppDelivery.findFirstOrThrow({
      where: { financialOrderId: order.id },
    });
    expect(await begin(stale.id)).toEqual([]);
    expect(
      (await h.owner.whatsAppDelivery.findUniqueOrThrow({ where: { id: stale.id } })).status,
    ).toBe('skipped');
    const next = await create(await bill()),
      d = await h.owner.whatsAppDelivery.findFirstOrThrow({ where: { financialOrderId: next.id } });
    const [notice] = await begin(d.id);
    expect(notice).toBeDefined();
    await h.owner.whatsAppDelivery.update({
      where: { id: d.id },
      data: { attemptedAt: new Date(Date.now() - 180000) },
    });
    await withMessaging(
      h.services.db,
      (tx) => tx.$queryRaw`SELECT * FROM messaging_claim_payment_notices('1234')`,
    );
    expect(await begin(d.id)).toEqual([]);
    expect((await h.owner.whatsAppDelivery.findUniqueOrThrow({ where: { id: d.id } })).status).toBe(
      'uncertain',
    );
    const other = await create(await bill()),
      moved = await h.owner.whatsAppDelivery.findFirstOrThrow({
        where: { financialOrderId: other.id },
      });
    await h.owner.patient.update({
      where: { id: clinics.a.patients[0]!.id },
      data: { phone: '+919000000002' },
    });
    expect(await begin(moved.id)).toEqual([]);
    expect(
      (await h.owner.whatsAppDelivery.findUniqueOrThrow({ where: { id: moved.id } })).skipReason,
    ).toBe('recipient_changed');
  });
  it('records refund updates separately, never reopens a refunded bill, and emits one availability notice', async () => {
    await pref();
    const { b, order, receipt } = await posted();
    h.services.cashfree!.refundsEnabled = true;
    h.services.cashfree!.refundGateway = {
      refunds: async () => [],
      refund: async () => null,
      createRefund: async (_m, input) => ({
        order_id: source(order),
        refund_id: input.refundId,
        cf_refund_id: '9999',
        cf_payment_id: receipt.reference!,
        refund_amount: input.amountPaise / 100,
        refund_currency: 'INR',
        refund_status: 'SUCCESS',
        refund_type: 'MERCHANT_INITIATED',
      }),
    };
    const response = await call('POST', `/payments/${receipt.id}/refunds`, admin, {
      id: randomUUID(),
      amountPaise: 10000,
      reason: 'overcharge',
    });
    expect(response.statusCode, response.body).toBe(200);
    expect((await call('GET', `/portal/bills/${b.id}`, patient)).json()).toMatchObject({
      paidPaise: 80000,
      balancePaise: 0,
      refundedPaise: 10000,
      netCollectedPaise: 70000,
      canPay: false,
    });
    const original = (await call('GET', `/portal/receipts/${receipt.id}`, patient)).json();
    expect(original.payment.amountPaise).toBe(80000);
    expect(original.refunds[0].amountPaise).toBe(10000);
    const d = await h.owner.whatsAppDelivery.findFirstOrThrow({ where: { kind: 'refund_ready' } });
    const [n] = await begin(d.id);
    const token = createFinanceLinkToken(d.id, n!.link_expires_at, h.services.paymentLinkSecret!);
    expect((await call('GET', '/portal/finance-links/' + token, patient)).json().sourceId).toBe(
      receipt.id,
    );
  });
  it('paginates receipts without duplicates and retains access to merged family history', async () => {
    const b = await bill();
    await cash(b, 10000);
    h.clock.advance(1);
    await cash(b, 20000);
    const first = (await call('GET', '/portal/receipts?limit=1', patient)).json();
    const second = (
      await call('GET', '/portal/receipts?limit=1&cursor=' + first.nextCursor, patient)
    ).json();
    expect(second.data[0].id).not.toBe(first.data[0].id);
    expect(second.nextCursor).toBeNull();
    const kept = await h.owner.patient.create({
      data: {
        organisationId: clinics.a.org.id,
        uhid: 'FIN-MERGED',
        name: 'Kept synthetic record',
        phone: '+919000000001',
      },
    });
    await h.owner.patient.update({
      where: { id: clinics.a.patients[0]!.id },
      data: { mergedIntoId: kept.id, mergedAt: h.services.now(), phone: null },
    });
    expect(
      (await call('GET', '/portal/bills?patientId=' + kept.id, patient)).json().data[0].id,
    ).toBe(b.id);
    expect((await call('GET', '/portal/receipts/' + first.data[0].id, patient)).statusCode).toBe(
      200,
    );
  });
});
