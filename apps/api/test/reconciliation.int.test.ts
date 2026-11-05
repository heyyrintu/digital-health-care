import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { withPayments, withTenant } from '@dhc/db';
import { processRun, scheduleNightly, claimDispatch } from '@dhc/reconciliation';
import {
  ReportFailure,
  type Merchant,
  type ReportEvent,
  type ReportSettlement,
  type ReportingGateway,
  type CreateOrderInput,
} from '@dhc/cashfree';
import { bearer, createHarness, resetDatabase, seedTwoClinics, staffLogin } from './harness';
const h = createHarness();
let clinics: Awaited<ReturnType<typeof seedTwoClinics>>,
  headers: ReturnType<typeof bearer>,
  other: ReturnType<typeof bearer>,
  doctor: ReturnType<typeof bearer>;
const m: Merchant = {
  clientId: 'synthetic-clinic-a',
  clientSecret: 'synthetic-secret-at-least-32-characters',
  environment: 'sandbox',
};
const gateway = {
  create: async (_m: Merchant, i: CreateOrderInput) => ({
    order_id: i.providerOrderId,
    order_amount: i.amountPaise / 100,
    order_currency: 'INR',
    order_status: 'ACTIVE' as const,
    payment_session_id: 'synthetic-session',
  }),
  order: async () => null,
  payments: async () => [],
  terminate: async () => {},
};
let events: ReportEvent[], settlements: ReportSettlement[];
const reports: ReportingGateway = {
  settlements: vi.fn(async () => ({ data: settlements, cursor: null })),
  events: vi.fn(async () => ({ data: events, cursor: null })),
  settlementEvents: vi.fn(async () => ({ data: events, cursor: null })),
};
const request = (method: 'GET' | 'POST', path: string, payload?: object, auth = headers) =>
  h.app.inject({ method, url: '/v1/reconciliation' + path, headers: auth, payload });
const org = () => clinics.a.org.id;
async function queue() {
  const r = await request('POST', '/runs', {
    id: randomUUID(),
    fromDate: '2026-11-03',
    toDate: '2026-11-03',
  });
  expect(r.statusCode, r.body).toBe(200);
  return r.json().run.id as string;
}
async function process(id: string, g = reports) {
  return processRun(h.services.db, org(), id, m, g, h.clock.now);
}
beforeEach(async () => {
  await resetDatabase(h.owner);
  h.clock.ms = Date.UTC(2026, 10, 5, 5);
  clinics = await seedTwoClinics(h);
  headers = bearer(await staffLogin(h, 'clinic-a', clinics.a.admin));
  other = bearer(await staffLogin(h, 'clinic-b', clinics.b.admin));
  doctor = bearer(await staffLogin(h, 'clinic-a', clinics.a.doctor));
  h.services.cashfree = {
    reconciliationEnabled: true,
    merchants: { [org()]: m },
    gateway,
    linkSecret: 'synthetic-link-secret-32-characters',
    webBaseUrl: 'https://app.test',
    notifyUrl: 'https://api.test/v1/webhooks/cashfree',
  };
  events = [];
  settlements = [];
  vi.clearAllMocks();
});
afterAll(async () => {
  await h.app.close();
  await h.owner.$disconnect();
});
const event = (order = 'outside'): ReportEvent => ({
  event_details: {
    event_id: '1234567890123456789',
    event_type: 'PAYMENT',
    event_status: 'SUCCESS',
    event_amount: '800',
    event_currency: 'INR',
    sale_type: 'CREDIT',
  },
  order_details: { order_id: order },
  payment_details: { cf_payment_id: '1234567890123456789' },
  settlement_details: { cf_settlement_id: 'settlement-1' },
});
const settlement = (): ReportSettlement => ({
  cf_settlement_id: 'settlement-1',
  status: 'SUCCESS',
  settlement_utr: 'UTR-1',
  payment_amount: '800',
  pg_service_charge: '16',
  pg_service_tax: '2.88',
  adjustment: 0,
  settlement_charge: 0,
  settlement_tax: 0,
  split_service_charge: 0,
  split_service_tax: 0,
  vendor_commission: 0,
  amount_settled: '781.12',
  charge_type: 'PREPAID',
});
describe('durable settlement reports', () => {
  it('matches a verified receipt and leaves its bill, receipt and refund ledgers unchanged', async () => {
    const place = await h.owner.clinic.create({
      data: { organisationId: org(), name: 'Synthetic clinic' },
    });
    const type = await h.owner.consultationType.create({
      data: {
        organisationId: org(),
        name: 'Visit',
        mode: 'in_person',
        defaultDurationMin: 15,
        feePaise: 80000,
      },
    });
    const visit = await h.owner.appointment.create({
      data: {
        organisationId: org(),
        patientId: clinics.a.patients[0]!.id,
        doctorUserId: clinics.a.doctor.userId,
        clinicId: place.id,
        consultationTypeId: type.id,
        date: new Date('2026-11-05'),
        startAt: h.services.now(),
        endAt: new Date(h.clock.ms + 900000),
        status: 'checked_in',
        source: 'front_desk',
        tokenNumber: 1,
        createdByUserId: clinics.a.doctor.userId,
      },
    });
    const billResponse = await h.app.inject({
      method: 'PUT',
      url: `/v1/appointments/${visit.id}/bill`,
      headers: doctor,
      payload: { revision: 0, consultation: 'consultation', items: [] },
    });
    expect(billResponse.statusCode, billResponse.body).toBe(200);
    const bill = billResponse.json();
    await h.owner.patient.update({
      where: { id: clinics.a.patients[0]!.id },
      data: { phone: '+919000000001' },
    });
    const orderId = randomUUID();
    const create = await h.app.inject({
      method: 'POST',
      url: `/v1/bills/${bill.id}/online-payment`,
      headers: doctor,
      payload: { id: orderId },
    });
    expect(create.statusCode, create.body).toBe(200);
    const providerId = 'dhc_' + orderId.replaceAll('-', '');
    const raw = JSON.stringify({
      type: 'PAYMENT_SUCCESS_WEBHOOK',
      data: {
        order: { order_id: providerId, order_amount: 800, order_currency: 'INR' },
        payment: {
          order_id: providerId,
          cf_payment_id: '1234567890123456789',
          payment_amount: 800,
          payment_currency: 'INR',
          payment_status: 'SUCCESS',
          is_captured: true,
        },
      },
    });
    const timestamp = String(h.clock.ms),
      signature = createHmac('sha256', m.clientSecret)
        .update(timestamp)
        .update(raw)
        .digest('base64');
    const callback = await h.app.inject({
      method: 'POST',
      url: '/v1/webhooks/cashfree',
      headers: {
        'content-type': 'application/json',
        'x-webhook-timestamp': timestamp,
        'x-webhook-signature': signature,
      },
      payload: raw,
    });
    expect(callback.statusCode, callback.body).toBe(200);
    const before = await h.owner.payment.findMany();
    const originalBill = await h.owner.bill.findUniqueOrThrow({ where: { id: bill.id } });
    events = [event(providerId)];
    settlements = [settlement()];
    const id = await queue();
    await process(id);
    expect((await request('GET', `/runs/${id}`)).json().run).toMatchObject({
      status: 'succeeded',
      mismatchCount: 0,
    });
    expect(await h.owner.payment.findMany()).toEqual(before);
    expect(await h.owner.bill.findUniqueOrThrow({ where: { id: bill.id } })).toEqual(originalBill);
    expect(await h.owner.refundEntry.count()).toBe(0);
  });

  it('authorizes admins, validates dates, deduplicates open requests and enforces tenants', async () => {
    expect((await request('GET', '/runs', undefined, doctor)).statusCode).toBe(403);
    expect(
      (
        await request('POST', '/runs', {
          id: randomUUID(),
          fromDate: '2026-11-05',
          toDate: '2026-11-05',
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await request('POST', '/runs', {
          id: randomUUID(),
          fromDate: '2026-09-01',
          toDate: '2026-11-01',
        })
      ).statusCode,
    ).toBe(400);
    const id = await queue();
    expect(await queue()).toBe(id);
    expect((await request('GET', `/runs/${id}`, undefined, other)).statusCode).toBe(404);
    expect((await request('GET', '/runs', undefined, other)).json().runs.data).toEqual([]);
    await expect(
      withTenant(h.services.db, org(), (tx) =>
        tx.cashfreeReconRun.update({ where: { id }, data: { status: 'running' } }),
      ),
    ).rejects.toThrow();
  });
  it('publishes complete paginated sanitized snapshots atomically, acknowledges without modifying financial records', async () => {
    events = [event()];
    settlements = [settlement()];
    const id = await queue();
    await process(id);
    const detail = (await request('GET', `/runs/${id}`)).json();
    expect(detail.run).toMatchObject({
      status: 'succeeded',
      eventCount: 2,
      settlementCount: 1,
      mismatchCount: 1,
    });
    const issue = (await request('GET', `/runs/${id}/issues`)).json().data[0];
    expect(issue.code).toBe('unknown_order');
    expect((await request('GET', `/runs/${id}/settlements`)).json().data[0]).toMatchObject({
      grossPaise: 80000,
      feesPaise: 1600,
      taxPaise: 288,
      netPaise: 78112,
    });
    expect(
      (await request('POST', `/issues/${issue.id}/review`, { reason: 'external_transaction' }))
        .statusCode,
    ).toBe(200);
    expect((await request('GET', `/runs/${id}`)).json().unreviewedCount).toBe(0);
    expect(await h.owner.payment.count()).toBe(0);
    expect(await h.owner.refundEntry.count()).toBe(0);
    await expect(
      withPayments(h.services.db, org(), (tx) =>
        tx.cashfreeReconRun.update({ where: { id }, data: { eventCount: 99 } }),
      ),
    ).rejects.toThrow();
    await expect(
      withPayments(h.services.db, org(), (tx) =>
        tx.cashfreeReconIssue.update({ where: { id: issue.id }, data: { reportedPaise: 9 } }),
      ),
    ).rejects.toThrow();
    expect(
      (await request('POST', `/issues/${issue.id}/review`, { reason: 'other' }, other)).statusCode,
    ).toBe(404);
    await process(id);
    expect(await h.owner.cashfreeReconEvent.count({ where: { runId: id } })).toBe(2);
  });
  it('does not publish partial pages; retries a durable failed run after backoff', async () => {
    const id = await queue();
    const paginated = {
      ...reports,
      events: vi.fn(async (c: Merchant, _f: string, _t: string, cursor: string | null) => {
        if (cursor) throw new ReportFailure();
        return { data: [event()], cursor: 'page2' };
      }),
    };
    await process(id, paginated);
    expect((await request('GET', `/runs/${id}`)).json().run).toMatchObject({
      status: 'failed',
      attempts: 1,
      errorCode: 'provider_unavailable',
      eventCount: 0,
    });
    expect(await h.owner.cashfreeReconEvent.count()).toBe(0);
    await process(id);
    expect((await request('GET', `/runs/${id}`)).json().run.attempts).toBe(1);
    h.clock.advance(120);
    await process(id);
    expect((await request('GET', `/runs/${id}`)).json().run.status).toBe('succeeded');
  });
  it('fences stale workers; ignores duplicate concurrent execution', async () => {
    const id = await queue();
    let release!: () => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>((r) => {
        entered = r;
      }),
      wait = new Promise<void>((r) => {
        release = r;
      });
    const slow = {
      ...reports,
      events: vi.fn(async () => {
        entered();
        await wait;
        return { data: [event()], cursor: null };
      }),
    };
    const first = process(id, slow);
    await enteredPromise;
    await process(id);
    expect(reports.events).not.toHaveBeenCalled();
    h.clock.advance(120);
    await process(id);
    release();
    await first;
    expect((await request('GET', `/runs/${id}`)).json().run).toMatchObject({
      status: 'succeeded',
      eventCount: 0,
      attempts: 2,
    });
    expect(await h.owner.cashfreeReconIssue.count()).toBe(0);
  });
  it('rejects changed merchant binding and limits processing attempts', async () => {
    const id = await queue();
    await processRun(h.services.db, org(), id, { ...m, clientId: 'changed' }, reports, h.clock.now);
    expect((await request('GET', `/runs/${id}`)).json().run.errorCode).toBe('binding_changed');
    expect(reports.events).not.toHaveBeenCalled();
    for (let i = 0; i < 7; i++) {
      h.clock.advance(7200);
      await processRun(h.services.db, org(), id, undefined, reports, h.clock.now);
    }
    expect((await h.owner.cashfreeReconRun.findUniqueOrThrow({ where: { id } })).attempts).toBe(5);
    expect(await claimDispatch(h.services.db, org(), h.services.now())).toEqual([]);
  });
  it('expires a crashed final attempt instead of leaving it running forever', async () => {
    const id = await queue();
    await withPayments(h.services.db, org(), (tx) =>
      tx.cashfreeReconRun.update({
        where: { id },
        data: {
          status: 'running',
          attempts: 5,
          leaseToken: randomUUID(),
          leaseUntil: new Date(h.clock.ms - 1),
        },
      }),
    );
    expect(await claimDispatch(h.services.db, org(), h.services.now())).toEqual([]);
    expect(await h.owner.cashfreeReconRun.findUniqueOrThrow({ where: { id } })).toMatchObject({
      status: 'failed',
      attempts: 5,
      errorCode: 'processing_failed',
    });
  });
  it('schedules once per IST day and reclaims dispatch after queue downtime', async () => {
    await scheduleNightly(h.services.db, org(), m, 7, new Date('2026-11-04T18:45:00Z'));
    expect(await h.owner.cashfreeReconRun.count()).toBe(0);
    await scheduleNightly(h.services.db, org(), m, 7, h.services.now());
    await scheduleNightly(h.services.db, org(), m, 7, h.services.now());
    const rows = await h.owner.cashfreeReconRun.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.fromDate.toISOString()).toBe('2026-10-29T00:00:00.000Z');
    expect(rows[0]?.toDate.toISOString()).toBe('2026-11-04T00:00:00.000Z');
    expect(await claimDispatch(h.services.db, org(), h.services.now())).toHaveLength(1);
    expect(await claimDispatch(h.services.db, org(), h.services.now())).toHaveLength(0);
    h.clock.advance(61);
    expect(await claimDispatch(h.services.db, org(), h.services.now())).toHaveLength(1);
  });
});
