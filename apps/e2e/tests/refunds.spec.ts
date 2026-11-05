import { randomUUID } from 'node:crypto';
import type { Db } from '@dhc/db';
import { expect, pageAlert, setUpFromInvite, test, type Clinic } from '../fixtures';

const today = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

/** An active doctor, a clinic, fees, a dressing on the price list and Asha checked in today. */
async function setUp(db: Db, clinic: Clinic) {
  const org = await db.organisation.findUniqueOrThrow({ where: { slug: clinic.slug } });
  const doctor = await db.user.findUniqueOrThrow({ where: { email: clinic.email('doctor') } });
  await db.membership.updateMany({
    where: { organisationId: org.id, userId: doctor.id },
    data: { status: 'active' },
  });
  const place = await db.clinic.create({ data: { organisationId: org.id, name: 'Main clinic' } });
  const type = await db.consultationType.create({
    data: {
      organisationId: org.id,
      name: 'In-person consultation',
      mode: 'in_person',
      defaultDurationMin: 15,
      feePaise: 80000,
      followUpFeePaise: 40000,
    },
  });
  const dressing = await db.priceListItem.create({
    data: { organisationId: org.id, name: 'Dressing', pricePaise: 15000 },
  });
  const patient = await db.patient.findFirstOrThrow({
    where: { organisationId: org.id },
    orderBy: { uhid: 'asc' },
  });
  const now = new Date();
  const appointment = await db.appointment.create({
    data: {
      organisationId: org.id,
      patientId: patient.id,
      doctorUserId: doctor.id,
      clinicId: place.id,
      consultationTypeId: type.id,
      date: new Date(`${today()}T00:00:00Z`),
      startAt: now,
      endAt: new Date(now.getTime() + 15 * 60_000),
      status: 'checked_in',
      source: 'walk_in',
      tokenNumber: 1,
      checkedInAt: now,
      createdByUserId: doctor.id,
    },
  });
  return { org, doctor, patient, appointment, dressing };
}

test('an admin confirms a partial refund, recovers the same request after an unknown response and prints its voucher', async ({
  page,
  clinic,
  db,
}) => {
  const { org, patient, appointment } = await setUp(db, clinic);
  await setUpFromInvite(page, clinic.inviteLink('clinic_admin'), 'admin synthetic passphrase');
  const billId = randomUUID(),
    paymentId = randomUUID();
  const payment = {
    id: paymentId,
    billId,
    mode: 'cashfree',
    amountPaise: 80000,
    reference: '123456789',
    receiptNumber: 'R00001',
    receivedAt: new Date().toISOString(),
    receivedByName: null,
  };
  const lines = [
    {
      id: randomUUID(),
      kind: 'consultation',
      priceListItemId: null,
      name: 'Synthetic visit',
      unitPaise: 80000,
      quantity: 1,
      amountPaise: 80000,
    },
  ];
  let confirmed = false,
    calls = 0,
    refundId = '';
  const sent: Record<string, unknown>[] = [];
  const bill = () => ({
    id: billId,
    appointmentId: appointment.id,
    status: 'paid',
    lines,
    subtotalPaise: 80000,
    discountPaise: 0,
    discountReason: null,
    totalPaise: 80000,
    paidPaise: 80000,
    balancePaise: 0,
    revision: 1,
    payments: [payment],
    refundedPaise: confirmed ? 20000 : 0,
    netCollectedPaise: confirmed ? 60000 : 80000,
  });
  const row = () => ({
    id: refundId,
    paymentId,
    amountPaise: 20000,
    status: confirmed ? 'succeeded' : 'creating',
    origin: 'app',
    reason: 'service_cancelled',
    createdAt: new Date().toISOString(),
    postedAt: confirmed ? new Date().toISOString() : null,
    voucherNumber: confirmed ? 'RF00001' : null,
    providerReference: confirmed ? '9001' : null,
  });
  const view = () => ({
    available: true,
    enabled: true,
    reviewRequired: false,
    refundedPaise: confirmed ? 20000 : 0,
    pendingPaise: refundId && !confirmed ? 20000 : 0,
    payments: [
      {
        id: paymentId,
        receiptNumber: 'R00001',
        amountPaise: 80000,
        refundablePaise: refundId ? 60000 : 80000,
        hasPending: !!refundId && !confirmed,
      },
    ],
    refunds: refundId ? [row()] : [],
  });
  await page.route(`**/v1/appointments/${appointment.id}/bill`, (route) =>
    route.fulfill({
      json: {
        bill: bill(),
        feePaise: 80000,
        followUpFeePaise: 40000,
        consultationTypeName: 'Synthetic visit',
        canEdit: false,
        canPay: false,
      },
    }),
  );
  await page.route(`**/v1/bills/${billId}/online-payment`, (route) =>
    route.fulfill({ json: { available: false, order: null } }),
  );
  await page.route(`**/v1/bills/${billId}/refunds`, (route) => route.fulfill({ json: view() }));
  await page.route(`**/v1/payments/${paymentId}/refunds`, (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    sent.push(body);
    refundId = body.id as string;
    calls++;
    if (calls === 1)
      return route.fulfill({
        status: 503,
        json: {
          error: {
            code: 'BUSINESS_RULE',
            message:
              'Refund provider is unavailable. Check the existing refund before trying again.',
            requestId: 'synthetic',
          },
        },
      });
    confirmed = true;
    return route.fulfill({ json: view() });
  });
  await page.route('**/v1/refunds/*/voucher', (route) =>
    route.fulfill({
      json: {
        refund: row(),
        originalReceipt: {
          payment,
          appointmentId: appointment.id,
          organisationName: org.name,
          patient: { name: patient.name, uhid: patient.uhid },
          doctorName: 'Synthetic doctor',
          visitDate: today(),
          lines,
          subtotalPaise: 80000,
          discountPaise: 0,
          totalPaise: 80000,
          paidToDatePaise: 80000,
          balanceAfterPaise: 0,
        },
      },
    }),
  );
  await page.goto(`/clinic/appointments/${appointment.id}/bill`);
  const card = page.getByTestId('refund-card');
  await expect(card).toBeVisible();
  await card.getByLabel('Original receipt', { exact: true }).selectOption(paymentId);
  await card.getByLabel('Refund amount (₹)').fill('200');
  await card.getByLabel('Reason for refund').selectOption('service_cancelled');
  await card.getByRole('button', { name: 'Request refund', exact: true }).click();
  const confirmation = card.getByRole('group', { name: 'Confirm refund', exact: true });
  await expect(confirmation).toContainText('R00001');
  await confirmation.getByRole('button', { name: 'Confirm refund', exact: true }).click();
  await expect(card.getByRole('alert')).toContainText('Refund provider is unavailable');
  await expect(confirmation.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
  await confirmation.getByRole('button', { name: 'Recover original request', exact: true }).click();
  await expect(card.getByRole('status')).toHaveText('Refund confirmed');
  expect(sent).toHaveLength(2);
  expect(sent[0]).toEqual(sent[1]);
  expect(sent[0]).toMatchObject({ amountPaise: 20000, reason: 'service_cancelled' });
  await card.getByRole('link', { name: 'RF00001', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Refund voucher', exact: true })).toBeVisible();
  await expect(page.getByText('R00001', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Print refund voucher' })).toBeVisible();
  // A refund-only day has negative net collections; it must still render.
  await page.route('**/v1/collections?*', (route) =>
    route.fulfill({
      json: {
        date: today(),
        totalPaise: 0,
        refundedPaise: 20000,
        netPaise: -20000,
        byMode: [],
        byDoctor: [],
        payments: [],
        dues: [],
        refunds: [
          {
            id: refundId,
            voucherNumber: 'RF00001',
            paymentId,
            receiptNumber: 'R00001',
            amountPaise: 20000,
            postedAt: new Date().toISOString(),
            appointmentId: appointment.id,
            patientName: patient.name,
          },
        ],
      },
    }),
  );
  await page.goto('/clinic/collections');
  await expect(page.getByTestId('collections-totals')).toContainText('−');
  await expect(page.getByTestId('collection-refunds')).toContainText('RF00001');
  await expect(pageAlert(page)).toHaveCount(0);
});
