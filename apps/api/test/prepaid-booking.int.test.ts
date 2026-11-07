import { createHmac, randomUUID } from 'node:crypto';
import { beforeEach, afterAll, describe, it, expect, vi } from 'vitest';
import {
  CURRENT_CONSENT_VERSIONS,
  ONLINE_CONSENT_VERSION,
  type TokenResponse,
} from '@dhc/contracts';
import { withPayments, withTenant } from '@dhc/db';
import { sweepPrepaidBookings } from '../src/payments/prepaid';
import { sweepOrganisation } from '../src/modules/appointments/no-shows';
import type { Merchant, ProviderOrder, ProviderPayment, CreateOrderInput } from '@dhc/cashfree';
import {
  bearer,
  createHarness,
  resetDatabase,
  seedTwoClinics,
  staffLogin,
  patientLogin,
} from './harness';
const h = createHarness(),
  m: Merchant = {
    clientId: 'synthetic',
    clientSecret: 'synthetic-secret-32-characters',
    environment: 'sandbox',
  };
let clinics: Awaited<ReturnType<typeof seedTwoClinics>>,
  patient: TokenResponse,
  admin: TokenResponse,
  doctor: TokenResponse,
  other: TokenResponse,
  place: string,
  type: string;
const remotes = new Map<string, ProviderOrder>(),
  payments = new Map<string, ProviderPayment[]>();
let unavailable = false,
  closing = false;
const gateway = {
  create: vi.fn(async (_m: Merchant, i: CreateOrderInput): Promise<ProviderOrder> => {
    if (unavailable) throw new Error('synthetic timeout');
    const r = {
      order_id: i.providerOrderId,
      order_amount: i.amountPaise / 100,
      order_currency: 'INR',
      order_status: 'ACTIVE' as const,
      payment_session_id: 'synthetic-session',
    };
    remotes.set(i.providerOrderId, r);
    return r;
  }),
  order: vi.fn(async (_m: Merchant, id: string) => {
    if (unavailable) throw new Error('synthetic unavailable');
    return remotes.get(id) ?? null;
  }),
  payments: vi.fn(async (_m: Merchant, id: string) => payments.get(id) ?? []),
  terminate: vi.fn(async (_m: Merchant, id: string) => {
    if (unavailable) throw new Error('synthetic unavailable');
    const r = remotes.get(id);
    if (r && r.order_status === 'ACTIVE')
      r.order_status = closing ? 'TERMINATION_REQUESTED' : 'TERMINATED';
  }),
};
const call = (method: 'GET' | 'POST' | 'PUT', path: string, payload?: object, token = patient) =>
  h.app.inject({ method, url: '/v1' + path, headers: bearer(token), payload });
const body = (id = randomUUID(), patientId = clinics.a.patients[0]!.id) => ({
  id,
  patientId,
  doctorUserId: clinics.a.doctor.userId,
  clinicId: place,
  consultationTypeId: type,
  startAt: '2026-11-06T04:30:00.000Z',
});
const view = (id: string) => call('GET', `/portal/prepaid-bookings/${id}`);
async function create(b = body()) {
  const r = await call('POST', '/portal/prepaid-bookings', b);
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as {
    id: string;
    appointmentId: string;
    state: string;
    paymentUrl: string | null;
    providerAvailable: boolean;
  };
}
async function paid(id: string, amount = 800) {
  const orderId = 'dhc_' + id.replaceAll('-', '');
  const p: ProviderPayment = {
    order_id: orderId,
    cf_payment_id: '1234567890123456789',
    payment_amount: amount,
    payment_currency: 'INR',
    payment_status: 'SUCCESS',
    is_captured: true,
  };
  payments.set(orderId, [p]);
  remotes.get(orderId)!.order_status = 'PAID';
  const raw = JSON.stringify({
      type: 'PAYMENT_SUCCESS_WEBHOOK',
      data: { order: { order_id: orderId, order_amount: 800, order_currency: 'INR' }, payment: p },
    }),
    timestamp = String(h.clock.ms),
    signature = createHmac('sha256', m.clientSecret).update(timestamp).update(raw).digest('base64');
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
beforeEach(async () => {
  await resetDatabase(h.owner);
  h.clock.ms = Date.UTC(2026, 10, 5, 4, 30);
  unavailable = false;
  closing = false;
  remotes.clear();
  payments.clear();
  vi.clearAllMocks();
  clinics = await seedTwoClinics(h);
  admin = await staffLogin(h, 'clinic-a', clinics.a.admin);
  doctor = await staffLogin(h, 'clinic-a', clinics.a.doctor);
  const person = clinics.a.patients[0]!;
  await h.owner.patient.update({ where: { id: person.id }, data: { phone: '+919876543210' } });
  patient = await patientLogin(h, 'clinic-a', '9876543210');
  other = await patientLogin(h, 'clinic-a', '9000000001');
  const accept = Object.entries(CURRENT_CONSENT_VERSIONS).map(([kind, version]) => ({
    kind,
    version,
  }));
  await call('POST', '/portal/consents', { accept });
  await call('POST', '/portal/consents', { accept }, other);
  place = (await call('POST', '/clinics', { name: 'Synthetic clinic' }, admin)).json().id;
  type = (
    await call(
      'POST',
      '/consultation-types',
      {
        name: 'Prepaid visit',
        mode: 'in_person',
        defaultDurationMin: 15,
        feePaise: 80000,
        requiresPrepayment: true,
      },
      admin,
    )
  ).json().id;
  const schedule = await call(
    'POST',
    '/availability/versions',
    {
      clinicId: place,
      consultationTypeId: type,
      effectiveFrom: '2026-11-05',
      weekly: { fri: [{ start: '10:00', end: '12:00' }] },
    },
    doctor,
  );
  expect(schedule.statusCode, schedule.body).toBe(201);
  h.services.cashfree = {
    prepaidBookingEnabled: true,
    merchants: { [clinics.a.org.id]: m },
    gateway,
    linkSecret: 'synthetic-link-secret-32-characters',
    webBaseUrl: 'https://app.test',
    notifyUrl: 'https://api.test/v1/webhooks/cashfree',
  };
});
afterAll(async () => {
  await h.app.close();
  await h.owner.$disconnect();
});
describe('prepaid in-person booking', () => {
  it('stays gated, rejects the free-booking bypass and enforces family ownership', async () => {
    h.services.cashfree!.prepaidBookingEnabled = false;
    expect((await call('POST', '/portal/prepaid-bookings', body())).statusCode).toBe(503);
    h.services.cashfree!.prepaidBookingEnabled = true;
    expect((await call('POST', '/portal/appointments', body())).statusCode).toBe(400);
    expect(
      (
        await call(
          'POST',
          '/portal/prepaid-bookings',
          body(randomUUID(), clinics.b.patients[0]!.id),
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (await call('POST', '/portal/prepaid-bookings', { ...body(), amountPaise: 1 })).statusCode,
    ).toBe(400);
    const r = await create();
    expect(
      (await call('GET', `/portal/prepaid-bookings/${r.id}`, undefined, other)).statusCode,
    ).toBe(404);
  });
  it('shows prepaid options only to supporting clients and serializes different reservation IDs', async () => {
    expect((await call('GET', '/portal/booking-options')).json().consultationTypes).toEqual([]);
    expect(
      (await call('GET', '/portal/booking-options?prepaid=true')).json().consultationTypes,
    ).toContainEqual(expect.objectContaining({ id: type, requiresPrepayment: true }));
    const results = await Promise.all([
      call('POST', '/portal/prepaid-bookings', body()),
      call('POST', '/portal/prepaid-bookings', body()),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(await h.owner.cashfreeBooking.count()).toBe(1);
    expect(await h.owner.bill.count()).toBe(1);
  });
  it('keeps an unknown provider order reserved at expiry, and a payment after the slot starts requires refund review', async () => {
    unavailable = true;
    const r = await create();
    h.clock.advance(31 * 60);
    await sweepPrepaidBookings(h.services);
    expect((await h.owner.cashfreeBooking.findUniqueOrThrow({ where: { id: r.id } })).state).toBe(
      'held',
    );
    unavailable = false;
    remotes.set('dhc_' + r.id.replaceAll('-', ''), {
      order_id: 'dhc_' + r.id.replaceAll('-', ''),
      order_amount: 800,
      order_currency: 'INR',
      order_status: 'ACTIVE',
      payment_session_id: 'synthetic-session',
    });
    h.clock.advance(86400);
    const callback = await paid(r.id);
    expect(callback.statusCode, callback.body).toBe(200);
    expect(await h.owner.cashfreeBooking.findUniqueOrThrow({ where: { id: r.id } })).toMatchObject({
      state: 'review',
    });
    expect(
      await h.owner.appointment.findUniqueOrThrow({ where: { id: r.appointmentId } }),
    ).toMatchObject({ status: 'cancelled' });
    expect(await h.owner.payment.count()).toBe(1);
  });
  it('atomically holds the slot and immutable server-priced bill, retrying once under concurrent submissions', async () => {
    const b = body();
    const [a, c] = await Promise.all([create(b), create(b)]);
    expect(a.id).toBe(c.id);
    expect(await h.owner.appointment.count()).toBe(1);
    expect(await h.owner.bill.count()).toBe(1);
    expect(a.state).toBe('held');
    expect(a.paymentUrl).toMatch(/^https:\/\/app.test\/pay\//);
    const slotQuery = `doctorId=${b.doctorUserId}&clinicId=${place}&consultationTypeId=${type}&date=2026-11-06`;
    const slots = (await call('GET', '/portal/slots?' + slotQuery)).json();
    expect(slots.slots.find((s: { start: string }) => s.start === b.startAt).available).toBe(false);
    expect(
      (
        await call(
          'POST',
          '/appointments',
          {
            patientId: clinics.a.patients[1]!.id,
            doctorUserId: b.doctorUserId,
            clinicId: place,
            consultationTypeId: type,
            startAt: b.startAt,
            walkIn: false,
            overbook: false,
          },
          doctor,
        )
      ).statusCode,
    ).toBe(409);
    expect(
      (await call('POST', `/appointments/${a.appointmentId}/actions`, { action: 'confirm' }, admin))
        .statusCode,
    ).not.toBe(200);
    const bill = await h.owner.bill.findUniqueOrThrow({
      where: { appointmentId: a.appointmentId },
    });
    expect(bill.totalPaise).toBe(80000);
    await expect(
      withTenant(h.services.db, clinics.a.org.id, (tx) =>
        tx.appointment.update({ where: { id: a.appointmentId }, data: { status: 'confirmed' } }),
      ),
    ).rejects.toThrow();
    await expect(
      withPayments(h.services.db, clinics.a.org.id, (tx) =>
        tx.bill.update({ where: { id: bill.id }, data: { totalPaise: 1 } }),
      ),
    ).rejects.toThrow();
    expect(
      (
        await call('POST', '/portal/prepaid-bookings', {
          ...b,
          startAt: '2026-11-06T04:45:00.000Z',
        })
      ).statusCode,
    ).toBe(409);
  });
  it('confirms only verified payment, posts one receipt, and does not regress on replay', async () => {
    const r = await create();
    expect((await view(r.id)).json().appointmentStatus).toBe('pending');
    expect(
      (await call('GET', `/portal/appointments/${r.appointmentId}`)).json().canReschedule,
    ).toBe(false);
    expect(
      (
        await call('POST', `/portal/appointments/${r.appointmentId}/reschedule`, {
          startAt: '2026-11-06T04:45:00.000Z',
        })
      ).statusCode,
    ).toBe(409);

    const callback = await paid(r.id);
    expect(callback.statusCode, callback.body).toBe(200);
    expect((await view(r.id)).json()).toMatchObject({
      state: 'confirmed',
      appointmentStatus: 'confirmed',
      paymentUrl: null,
    });
    expect(
      (
        await call('POST', `/portal/appointments/${r.appointmentId}/reschedule`, {
          startAt: '2026-11-06T04:45:00.000Z',
        })
      ).statusCode,
    ).toBe(409);
    await paid(r.id);
    expect(await h.owner.payment.count()).toBe(1);
    expect(
      await h.owner.appointmentStatusHistory.count({
        where: { appointmentId: r.appointmentId, toStatus: 'confirmed' },
      }),
    ).toBe(1);
    expect(
      (
        await call(
          'POST',
          `/appointments/${r.appointmentId}/reschedule`,
          { startAt: '2026-11-06T04:45:00.000Z' },
          doctor,
        )
      ).statusCode,
    ).toBe(409);
  });
  it('preserves the clinic manual approval rule after payment', async () => {
    await h.owner.bookingRules.upsert({
      where: { organisationId: clinics.a.org.id },
      create: { organisationId: clinics.a.org.id, autoConfirm: false },
      update: { autoConfirm: false },
    });
    const r = await create();
    const response = await paid(r.id);
    expect(response.statusCode, response.body).toBe(200);
    expect((await view(r.id)).json()).toMatchObject({
      state: 'confirmed',
      appointmentStatus: 'pending',
    });
    const confirm = await call(
      'POST',
      `/appointments/${r.appointmentId}/actions`,
      { action: 'confirm' },
      admin,
    );
    expect(confirm.statusCode, confirm.body).toBe(200);
  });
  it('recovers unknown creation with the same IDs, supports dependant accounts, and preserves fee snapshots', async () => {
    const child = await h.owner.patient.create({
      data: {
        organisationId: clinics.a.org.id,
        uhid: 'CHILD-1',
        name: 'Synthetic child',
        guardianPatientId: clinics.a.patients[0]!.id,
      },
    });
    unavailable = true;
    const b = body(randomUUID(), child.id),
      r = await create(b);
    expect(r.providerAvailable).toBe(false);
    expect(r.state).toBe('held');
    await h.owner.consultationType.update({ where: { id: type }, data: { feePaise: 90000 } });
    unavailable = false;
    const retry = await create(b);
    expect(retry.id).toBe(r.id);
    expect(remotes.get('dhc_' + r.id.replaceAll('-', ''))?.order_amount).toBe(800);
    expect(gateway.create.mock.calls.at(-1)?.[1].phone).toBe('+919876543210');
  });
  it('retains uncertain and closing holds until provider-confirmed closure; late success never restores the slot', async () => {
    const r = await create();
    h.clock.advance(31 * 60);
    unavailable = true;
    await sweepPrepaidBookings(h.services);
    expect((await view(r.id)).json().state).toBe('held');
    unavailable = false;
    closing = true;
    h.clock.advance(121);
    await sweepPrepaidBookings(h.services);
    expect((await view(r.id)).json().state).toBe('held');
    remotes.get('dhc_' + r.id.replaceAll('-', ''))!.order_status = 'TERMINATED';
    h.clock.advance(121);
    await sweepPrepaidBookings(h.services);
    expect((await view(r.id)).json()).toMatchObject({
      state: 'released',
      appointmentStatus: 'cancelled',
    });
    expect((await paid(r.id)).statusCode).toBe(200);
    expect((await view(r.id)).json()).toMatchObject({
      state: 'review',
      appointmentStatus: 'cancelled',
    });
    expect(await h.owner.payment.count()).toBe(1);
  });
  it('checks paid status before attempting closure and can cancel an unpaid reservation explicitly', async () => {
    const r = await create();
    const close = await call('POST', `/portal/prepaid-bookings/${r.id}/close`);
    expect(close.statusCode, close.body).toBe(200);
    expect(close.json().state).toBe('released');
    const again = await create({ ...body(), startAt: '2026-11-06T04:45:00.000Z' });
    const id = 'dhc_' + again.id.replaceAll('-', '');
    remotes.get(id)!.order_status = 'PAID';
    payments.set(id, [
      {
        order_id: id,
        cf_payment_id: '999999999',
        payment_status: 'SUCCESS',
        payment_amount: 800,
        payment_currency: 'INR',
        is_captured: true,
      },
    ]);
    gateway.terminate.mockClear();
    const result = await call('POST', `/portal/prepaid-bookings/${again.id}/close`);
    expect(result.json().state).toBe('confirmed');
    expect(gateway.terminate).not.toHaveBeenCalled();
  });
  it('never confirms mismatched amounts or turns unpaid holds into no-shows', async () => {
    const r = await create();
    await paid(r.id, 799);
    expect((await view(r.id)).json().state).toBe('held');
    expect(await h.owner.payment.count()).toBe(0);
    h.clock.advance(2 * 86400);
    await sweepOrganisation(
      h.services,
      { id: 'synthetic-sweep', ip: '127.0.0.1', headers: {} },
      clinics.a.org.id,
    );
    expect(
      (await h.owner.appointment.findUniqueOrThrow({ where: { id: r.appointmentId } })).status,
    ).toBe('pending');
  });
});

async function enableOnline(mode: 'audio' | 'video') {
  await h.owner.consultationType.update({ where: { id: type }, data: { mode } });
  await h.owner.user.update({
    where: { id: clinics.a.doctor.userId },
    data: { displayName: 'Synthetic online doctor' },
  });
  await h.owner.patient.update({
    where: { id: clinics.a.patients[0]!.id },
    data: { dob: new Date('1990-01-01') },
  });
  await h.owner.doctorProfile.create({
    data: {
      organisationId: clinics.a.org.id,
      userId: clinics.a.doctor.userId,
      registrationNumber: 'SYNTHETIC-ONLINE',
      council: 'Synthetic council',
      qualifications: 'Synthetic qualification',
      verification: 'verified',
      verifiedAt: h.services.now(),
    },
  });
  await h.owner.onlineVisitSettings.create({
    data: { organisationId: clinics.a.org.id, enabled: true },
  });
}
for (const mode of ['audio', 'video'] as const) {
  describe('prepaid ' + mode + ' booking', () => {
    it('requires both clinic online enablement and payments, supporting clients and a verified doctor', async () => {
      await enableOnline(mode);
      expect((await call('GET', '/portal/booking-options')).json().consultationTypes).toEqual([]);
      expect(
        (await call('GET', '/portal/booking-options?prepaid=true')).json().consultationTypes,
      ).toContainEqual(expect.objectContaining({ id: type, mode, requiresPrepayment: true }));
      expect((await call('POST', '/portal/appointments', body())).statusCode).toBe(400);
      await h.owner.onlineVisitSettings.update({
        where: { organisationId: clinics.a.org.id },
        data: { enabled: false, version: { increment: 1 } },
      });
      expect((await call('POST', '/portal/prepaid-bookings', body())).statusCode).toBe(400);
      expect(
        (await call('GET', '/portal/booking-options?prepaid=true')).json().consultationTypes,
      ).toEqual([]);
      await h.owner.onlineVisitSettings.update({
        where: { organisationId: clinics.a.org.id },
        data: { enabled: true, version: { increment: 1 } },
      });
      await h.owner.doctorProfile.updateMany({
        data: { verification: 'pending', verifiedAt: null },
      });
      expect((await call('POST', '/portal/prepaid-bookings', body())).statusCode).toBe(409);
      await h.owner.doctorProfile.updateMany({
        data: { verification: 'verified', verifiedAt: h.services.now() },
      });
      h.services.cashfree!.prepaidBookingEnabled = false;
      expect((await call('POST', '/portal/prepaid-bookings', body())).statusCode).toBe(503);
      expect(
        (await call('GET', '/portal/booking-options?prepaid=true')).json().consultationTypes,
      ).toEqual([]);
      expect(await h.owner.cashfreeBooking.count()).toBe(0);
      expect(gateway.create).not.toHaveBeenCalled();
    });
    it('holds an unpaid visit and confirms a single verified receipt without bypassing online consent or joining rules', async () => {
      await enableOnline(mode);
      const b = body(),
        r = await create(b);
      const online = '/portal/appointments/' + r.appointmentId + '/online';
      const staff = '/appointments/' + r.appointmentId + '/online';
      expect((await view(r.id)).json().appointmentStatus).toBe('pending');
      expect((await call('POST', online + '/join')).statusCode).toBe(409);
      expect(
        (
          await call(
            'POST',
            '/appointments/' + r.appointmentId + '/actions',
            { action: 'confirm' },
            admin,
          )
        ).statusCode,
      ).not.toBe(200);
      const paidResponse = await paid(r.id);
      expect(paidResponse.statusCode, paidResponse.body).toBe(200);
      expect((await paid(r.id)).statusCode).toBe(200);
      expect((await view(r.id)).json()).toMatchObject({
        state: 'confirmed',
        appointmentStatus: 'confirmed',
        paymentUrl: null,
      });
      expect(await h.owner.payment.count()).toBe(1);
      h.clock.ms = Date.parse(b.startAt) - 5 * 60000;
      patient = await patientLogin(h, 'clinic-a', '9876543210');
      admin = await staffLogin(h, 'clinic-a', clinics.a.admin);
      doctor = await staffLogin(h, 'clinic-a', clinics.a.doctor);
      expect((await call('POST', online + '/join')).statusCode).toBe(409);
      const link = 'https://meet.google.com/abc-defg-hij',
        phone = '+919000000010';
      const configured = await call(
        'PUT',
        staff + '/call',
        {
          version: 0,
          meetingUrl: mode === 'video' ? link : null,
          callPhone: mode === 'audio' ? phone : null,
        },
        admin,
      );
      expect(configured.statusCode, configured.body).toBe(200);
      const consent = await call('PUT', online, {
        version: 1,
        consentVersion: ONLINE_CONSENT_VERSION,
        agreed: true,
        identity: {
          name: 'Synthetic online patient',
          dob: '1990-01-01',
          address: 'Synthetic address, India',
          guardianName: null,
          guardianRelationship: null,
          authorityConfirmed: true,
        },
      });
      expect(consent.statusCode, consent.body).toBe(200);
      const checked = await call(
        'POST',
        staff + '/verify',
        {
          version: 2,
          method: mode,
          identityConfirmed: true,
          ageConfirmed: true,
          guardianConfirmed: false,
          suitable: true,
        },
        doctor,
      );
      expect(checked.statusCode, checked.body).toBe(200);
      expect((await call('POST', online + '/join')).json().url).toBe(
        mode === 'video' ? link : 'tel:' + phone,
      );
      expect((await call('POST', online + '/withdraw', { version: 3 })).statusCode).toBe(200);
      expect((await call('POST', online + '/join')).statusCode).toBe(409);
      expect(await h.owner.payment.count()).toBe(1);
      expect((await view(r.id)).json().state).toBe('confirmed');
    });
  });
}
