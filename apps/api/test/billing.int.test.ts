import {
  Bill,
  BillView,
  CollectionsReport,
  Payment,
  PriceList,
  PriceListItem,
  QueueResponse,
  Receipt,
  type TokenResponse,
} from '@dhc/contracts';
import { withTenant } from '@dhc/db';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addStaff,
  bearer,
  createHarness,
  resetDatabase,
  seedTwoClinics,
  staffLogin,
} from './harness';

const h = createHarness();
let clinics: Awaited<ReturnType<typeof seedTwoClinics>>;
let admin: TokenResponse;
let doctor: TokenResponse;
let desk: TokenResponse;
let adminB: TokenResponse;
let clinicId: string;
let typeId: string;

beforeEach(async () => {
  h.clock.ms = Date.UTC(2026, 9, 6, 4, 30);
  await resetDatabase(h.owner);
  clinics = await seedTwoClinics(h);
  const frontDesk = await addStaff(h, clinics.a.org.id, 'front_desk', 'desk@clinic-a.test');
  admin = await staffLogin(h, 'clinic-a', clinics.a.admin);
  doctor = await staffLogin(h, 'clinic-a', clinics.a.doctor);
  desk = await staffLogin(h, 'clinic-a', frontDesk);
  adminB = await staffLogin(h, 'clinic-b', clinics.b.admin);
  const org = clinics.a.org.id;
  clinicId = (await h.owner.clinic.create({ data: { organisationId: org, name: 'Main clinic' } }))
    .id;
  typeId = (
    await h.owner.consultationType.create({
      data: {
        organisationId: org,
        name: 'In-person consultation',
        mode: 'in_person',
        defaultDurationMin: 15,
        feePaise: 80000,
        followUpFeePaise: 40000,
      },
    })
  ).id;
});

afterAll(async () => {
  await h.app.close();
  await h.owner.$disconnect();
});

const call = (method: string, url: string, tokens: TokenResponse | null, payload?: unknown) =>
  h.app.inject({
    method: method as 'GET',
    url: `/v1${url}`,
    headers: tokens ? bearer(tokens) : {},
    payload: payload as object,
  });

let token = 0;
/** A clinic A visit on 6 Oct 2026, straight into the database. */
async function visit(
  status: 'confirmed' | 'checked_in' | 'in_consultation' | 'completed' = 'checked_in',
  patient = 0,
) {
  const startAt = new Date('2026-10-06T04:30:00.000Z');
  token += 1;
  const row = await h.owner.appointment.create({
    data: {
      organisationId: clinics.a.org.id,
      patientId: clinics.a.patients[patient]!.id,
      doctorUserId: clinics.a.doctor.userId,
      clinicId,
      consultationTypeId: typeId,
      date: new Date('2026-10-06T00:00:00.000Z'),
      startAt,
      endAt: new Date(startAt.getTime() + 15 * 60_000),
      status,
      source: 'front_desk',
      tokenNumber: token,
      createdByUserId: clinics.a.doctor.userId,
    },
  });
  return row.id;
}

async function item(name: string, pricePaise: number) {
  const res = await call('POST', '/price-list', admin, { name, pricePaise });
  expect(res.statusCode).toBe(201);
  return PriceListItem.parse(res.json());
}

/** The API's error envelope. */
const err = (error: Record<string, unknown>) => ({ error });

const saveBill = (id: string, body: Record<string, unknown>, tokens = desk) =>
  call('PUT', `/appointments/${id}/bill`, tokens, {
    revision: 0,
    consultation: 'consultation',
    items: [],
    ...body,
  });

const pay = (billId: string, amountPaise: number, mode = 'cash', id = randomUUID()) =>
  call('POST', `/bills/${billId}/payments`, desk, {
    id,
    mode,
    amountPaise,
    reference: mode === 'cash' ? null : 'UTR123',
  });

describe('price list', () => {
  it('is kept by the clinic admin and read by every staff role', async () => {
    const dressing = await item('Dressing', 15000);
    expect(
      (await call('POST', '/price-list', desk, { name: 'X', pricePaise: 100 })).statusCode,
    ).toBe(403);
    expect(
      (await call('POST', '/price-list', admin, { name: 'Dressing', pricePaise: 100 })).json(),
    ).toMatchObject(err({ code: 'CONFLICT', fields: { name: 'taken' } }));

    const updated = await call('PATCH', `/price-list/${dressing.id}`, admin, {
      pricePaise: 20000,
      active: false,
    });
    expect(updated.json()).toMatchObject({ pricePaise: 20000, active: false });

    for (const tokens of [desk, doctor, admin]) {
      const list = PriceList.parse((await call('GET', '/price-list', tokens)).json());
      expect(list.data.map((i) => i.name)).toEqual(['Dressing']);
    }
    // Another clinic sees nothing of it.
    expect(PriceList.parse((await call('GET', '/price-list', adminB)).json()).data).toEqual([]);
    expect(
      (await call('PATCH', `/price-list/${dressing.id}`, adminB, { active: true })).statusCode,
    ).toBe(404);
  });
});

describe('bills', () => {
  it('prices every line on the server, with a discount that needs a reason', async () => {
    const dressing = await item('Dressing', 15000);
    const id = await visit();

    const view = BillView.parse((await call('GET', `/appointments/${id}/bill`, desk)).json());
    expect(view).toMatchObject({
      bill: null,
      feePaise: 80000,
      followUpFeePaise: 40000,
      canEdit: true,
      canPay: false,
    });

    expect((await saveBill(id, { discountPaise: 5000 })).json()).toMatchObject(
      err({ code: 'VALIDATION_FAILED', fields: { discountReason: expect.any(String) } }),
    );

    const res = await saveBill(id, {
      consultation: 'follow_up',
      // Prices sent by a client are ignored: the server prices every line.
      items: [{ priceListItemId: dressing.id, quantity: 2, unitPaise: 1 }],
      discountPaise: 5000,
      discountReason: 'Senior citizen',
    });
    expect(res.statusCode).toBe(200);
    const bill = Bill.parse(res.json());
    expect(bill.lines.map((l) => [l.kind, l.name, l.unitPaise, l.quantity, l.amountPaise])).toEqual(
      [
        ['follow_up', 'In-person consultation', 40000, 1, 40000],
        ['item', 'Dressing', 15000, 2, 30000],
      ],
    );
    expect(bill).toMatchObject({
      subtotalPaise: 70000,
      discountPaise: 5000,
      totalPaise: 65000,
      paidPaise: 0,
      balancePaise: 65000,
      status: 'due',
      revision: 1,
    });

    // A later price change does not touch the bill.
    await call('PATCH', `/price-list/${dressing.id}`, admin, { pricePaise: 99900 });
    const again = BillView.parse((await call('GET', `/appointments/${id}/bill`, admin)).json());
    expect(again.bill!.totalPaise).toBe(65000);
    // Clinic admins view but do not bill.
    expect(again).toMatchObject({ canEdit: false, canPay: false });
    expect((await saveBill(id, { revision: 1 }, admin)).statusCode).toBe(403);
  });

  it('refuses visits not yet arrived, stale revisions, unknown items and too large discounts', async () => {
    const booked = await visit('confirmed');
    expect((await saveBill(booked, {})).statusCode).toBe(409);

    const id = await visit('completed', 1);
    expect((await saveBill(id, {})).statusCode).toBe(200);
    expect((await saveBill(id, { revision: 0 })).json()).toMatchObject(
      err({
        code: 'CONFLICT',
        fields: { revision: 'stale' },
      }),
    );
    expect(
      (await saveBill(id, { revision: 1, discountPaise: 90000, discountReason: 'x' })).json(),
    ).toMatchObject(err({ code: 'VALIDATION_FAILED', fields: { discountPaise: 'invalid' } }));

    const old = await item('Old item', 1000);
    await call('PATCH', `/price-list/${old.id}`, admin, { active: false });
    expect(
      (
        await saveBill(id, { revision: 1, items: [{ priceListItemId: old.id, quantity: 1 }] })
      ).json(),
    ).toMatchObject(err({ code: 'VALIDATION_FAILED', fields: { items: 'invalid' } }));

    // Another clinic's item is not on this clinic's list.
    const theirs = await call('POST', '/price-list', adminB, { name: 'Theirs', pricePaise: 500 });
    expect(
      (
        await saveBill(id, {
          revision: 1,
          items: [{ priceListItemId: PriceListItem.parse(theirs.json()).id, quantity: 1 }],
        })
      ).statusCode,
    ).toBe(400);
  });
});

describe('payments and receipts', () => {
  it('takes part payments up to the balance, numbers receipts and fixes the bill', async () => {
    const id = await visit();
    const bill = Bill.parse((await saveBill(id, {})).json());

    const cash = await pay(bill.id, 30000, 'cash');
    expect(cash.statusCode).toBe(201);
    expect(Payment.parse(cash.json())).toMatchObject({
      mode: 'cash',
      amountPaise: 30000,
      reference: null,
      receiptNumber: 'R00001',
    });

    expect((await pay(bill.id, 50001, 'upi')).json()).toMatchObject(
      err({
        code: 'VALIDATION_FAILED',
        fields: { amountPaise: 'invalid' },
      }),
    );
    // Once a payment is in, the lines are fixed.
    expect((await saveBill(id, { revision: 2 })).statusCode).toBe(409);

    const upi = Payment.parse((await pay(bill.id, 50000, 'upi')).json());
    expect(upi).toMatchObject({ receiptNumber: 'R00002', reference: 'UTR123' });
    expect((await pay(bill.id, 1, 'cash')).statusCode).toBe(409);

    const view = BillView.parse((await call('GET', `/appointments/${id}/bill`, desk)).json());
    expect(view.bill).toMatchObject({ status: 'paid', paidPaise: 80000, balancePaise: 0 });
    expect(view).toMatchObject({ canEdit: false, canPay: false });

    const first = Receipt.parse(
      (await call('GET', `/payments/${Payment.parse(cash.json()).id}/receipt`, admin)).json(),
    );
    expect(first).toMatchObject({
      organisationName: clinics.a.org.name,
      patient: { name: clinics.a.patients[0]!.name, uhid: clinics.a.patients[0]!.uhid },
      visitDate: '2026-10-06',
      totalPaise: 80000,
      paidToDatePaise: 30000,
      balanceAfterPaise: 50000,
    });
    const audit = await h.owner.auditLog.findMany({ where: { action: 'receipt.viewed' } });
    expect(audit).toHaveLength(1);
    // Another clinic cannot read it.
    expect((await call('GET', `/payments/${upi.id}/receipt`, adminB)).statusCode).toBe(404);
  });

  it('ends a simultaneous save and payment cleanly', async () => {
    const id = await visit();
    const bill = Bill.parse((await saveBill(id, {})).json());
    const [save, payment] = await Promise.all([
      saveBill(id, { revision: bill.revision, consultation: 'follow_up' }),
      pay(bill.id, 10000),
    ]);
    expect(payment.statusCode).toBe(201);
    // Whichever went first, the save either landed before the payment or was refused.
    expect([200, 409]).toContain(save.statusCode);
    const view = BillView.parse((await call('GET', `/appointments/${id}/bill`, desk)).json());
    expect(view.bill!.paidPaise).toBe(10000);
  });

  it('records a retried payment once', async () => {
    const id = await visit();
    const bill = Bill.parse((await saveBill(id, {})).json());
    const paymentId = randomUUID();
    expect((await pay(bill.id, 20000, 'card', paymentId)).statusCode).toBe(201);
    const retry = await pay(bill.id, 20000, 'card', paymentId);
    expect(retry.statusCode).toBe(200);
    expect(Payment.parse(retry.json()).receiptNumber).toBe('R00001');
    expect((await pay(bill.id, 25000, 'card', paymentId)).statusCode).toBe(409);
    expect(await h.owner.payment.count()).toBe(1);
  });

  it('gives simultaneous payments different receipt numbers', async () => {
    const bills = await Promise.all(
      [0, 1, 0].map(async (p) =>
        Bill.parse((await saveBill(await visit('checked_in', p), {})).json()),
      ),
    );
    const results = await Promise.all(bills.map((b) => pay(b.id, 80000)));
    const numbers = results.map((r) => Payment.parse(r.json()).receiptNumber).sort();
    expect(numbers).toEqual(['R00001', 'R00002', 'R00003']);
  });

  it('keeps payments append-only and on bills of the same clinic', async () => {
    const id = await visit();
    const bill = Bill.parse((await saveBill(id, {})).json());
    const payment = Payment.parse((await pay(bill.id, 10000)).json());
    await expect(
      withTenant(h.services.db, clinics.a.org.id, (tx) =>
        tx.payment.update({ where: { id: payment.id }, data: { amountPaise: 1 } }),
      ),
    ).rejects.toThrow(/permission denied/);
    // The owner bypasses RLS, but the triggers still hold.
    await expect(
      h.owner.payment.create({
        data: {
          id: randomUUID(),
          organisationId: clinics.b.org.id,
          billId: bill.id,
          mode: 'cash',
          amountPaise: 100,
          receiptNumber: 'X1',
          receivedByUserId: clinics.a.doctor.userId,
        },
      }),
    ).rejects.toThrow(/payment does not match its bill/);
    await expect(h.owner.billItem.deleteMany({ where: { billId: bill.id } })).rejects.toThrow(
      /can no longer change/,
    );
  });
});

describe('collections and the queue', () => {
  it('totals a day by mode and doctor and lists what is still due', async () => {
    const paidVisit = await visit('completed', 0);
    const dueVisit = await visit('completed', 1);
    const paid = Bill.parse((await saveBill(paidVisit, {})).json());
    await pay(paid.id, 50000, 'cash');
    await pay(paid.id, 30000, 'upi');
    const due = Bill.parse((await saveBill(dueVisit, {})).json());
    await pay(due.id, 20000, 'card');

    const report = CollectionsReport.parse(
      (await call('GET', '/collections?date=2026-10-06', admin)).json(),
    );
    expect(report.totalPaise).toBe(100000);
    expect(report.byMode).toEqual([
      { mode: 'cash', count: 1, amountPaise: 50000 },
      { mode: 'upi', count: 1, amountPaise: 30000 },
      { mode: 'card', count: 1, amountPaise: 20000 },
    ]);
    expect(report.byDoctor).toEqual([
      expect.objectContaining({
        doctorUserId: clinics.a.doctor.userId,
        count: 3,
        amountPaise: 100000,
      }),
    ]);
    expect(report.dues).toEqual([
      expect.objectContaining({ appointmentId: dueVisit, balancePaise: 60000 }),
    ]);
    // Another day is empty, and another clinic sees none of it.
    expect(
      CollectionsReport.parse((await call('GET', '/collections?date=2026-10-07', admin)).json())
        .totalPaise,
    ).toBe(0);
    expect(
      CollectionsReport.parse((await call('GET', '/collections?date=2026-10-06', adminB)).json())
        .payments,
    ).toEqual([]);

    const queue = QueueResponse.parse((await call('GET', '/queue?date=2026-10-06', desk)).json());
    const cards = new Map(queue.completed.map((a) => [a.id, a.bill]));
    expect(cards.get(paidVisit)).toEqual({ totalPaise: 80000, paidPaise: 80000, status: 'paid' });
    expect(cards.get(dueVisit)).toEqual({
      totalPaise: 80000,
      paidPaise: 20000,
      status: 'partly_paid',
    });
  });
});
