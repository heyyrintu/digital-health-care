import { randomUUID } from 'node:crypto';
import type { Db } from '@dhc/db';
import { expect, setUpFromInvite, test, type Clinic } from '../fixtures';

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

test.describe('billing', () => {
  test('front desk bills a visit, takes cash then UPI, and prints the receipt', async ({
    page,
    clinic,
    db,
  }) => {
    const { patient } = await setUp(db, clinic);
    await setUpFromInvite(page, clinic.inviteLink('front_desk'), 'desk synthetic passphrase');

    await page.getByRole('link', { name: 'Queue' }).click();
    const row = page.getByTestId(`appointment-${patient.uhid}`);
    await row.getByRole('link', { name: 'Bill' }).click();
    await expect(page.getByRole('heading', { name: `Bill for ${patient.name}` })).toBeVisible();

    // The consultation fee, two dressings and a discount with its reason.
    await expect(page.getByLabel('Consultation fee (₹800)')).toBeChecked();
    await page
      .getByLabel('Add an item from the price list')
      .selectOption({ label: 'Dressing · ₹150' });
    await page.getByLabel('Quantity of Dressing').fill('2');
    await page.getByLabel('Discount (₹)').fill('100');
    await page.getByLabel('Reason for the discount').fill('Senior citizen');
    await expect(page.getByTestId('bill-totals')).toContainText('₹1,000');
    await page.getByRole('button', { name: 'Save bill' }).click();
    await expect(page.getByRole('status')).toContainText('Bill saved.');
    await expect(page.getByTestId('bill-status')).toContainText('Due');

    // Part in cash, the rest by UPI.
    await page.getByLabel('Amount (₹)').fill('400');
    await page.getByRole('button', { name: 'Record payment' }).click();
    await expect(page.getByRole('status')).toContainText('Receipt R00001');
    await expect(page.getByTestId('bill-status')).toContainText('Partly paid');
    await expect(page.getByText('This bill has a payment')).toBeVisible();

    await page.getByText('UPI', { exact: true }).click();
    await expect(page.getByLabel('Amount (₹)')).toHaveValue('600');
    await page.getByLabel('UPI or card reference (optional)').fill('UTR42');
    await page.getByRole('button', { name: 'Record payment' }).click();
    await expect(page.getByTestId('bill-status')).toContainText('Paid');
    await expect(page.getByRole('button', { name: 'Record payment' })).toHaveCount(0);

    await page.getByRole('link', { name: 'Receipt R00002' }).click();
    const receipt = page.getByTestId('receipt');
    await expect(receipt.getByRole('heading', { name: 'Receipt R00002' })).toBeVisible();
    await expect(receipt).toContainText(patient.uhid);
    await expect(receipt).toContainText('Reference UTR42');
    await expect(receipt).toContainText('Balance after this payment₹0');
    await expect(page.getByRole('button', { name: 'Print receipt' })).toBeVisible();

    await page.getByRole('link', { name: 'Queue' }).click();
    await expect(
      page.getByTestId(`appointment-${patient.uhid}`).getByTestId('bill-chip'),
    ).toHaveText('₹1,000 · Paid');
  });

  test('the clinic admin keeps the price list and reads the day’s collections', async ({
    page,
    clinic,
    db,
  }) => {
    const { org, doctor, patient, appointment } = await setUp(db, clinic);
    // A bill for today with ₹500 of ₹800 paid in cash.
    const bill = await db.bill.create({
      data: {
        organisationId: org.id,
        appointmentId: appointment.id,
        patientId: patient.id,
        doctorUserId: doctor.id,
        subtotalPaise: 80000,
        totalPaise: 80000,
        createdByUserId: doctor.id,
        items: {
          create: {
            organisationId: org.id,
            kind: 'consultation',
            name: 'In-person consultation',
            unitPaise: 80000,
            quantity: 1,
            amountPaise: 80000,
            sortOrder: 0,
          },
        },
      },
    });
    await db.payment.create({
      data: {
        id: randomUUID(),
        organisationId: org.id,
        billId: bill.id,
        mode: 'cash',
        amountPaise: 50000,
        receiptNumber: 'R00001',
        receivedByUserId: doctor.id,
      },
    });
    await db.bill.update({
      where: { id: bill.id },
      data: { paidPaise: 50000, status: 'partly_paid' },
    });

    await setUpFromInvite(page, clinic.inviteLink('clinic_admin'), 'admin synthetic passphrase');
    const prices = page.getByRole('region', { name: 'Price list' });
    await prices.getByLabel('Item', { exact: true }).fill('Injection');
    await prices.getByLabel('Price (₹)').fill('120');
    await prices.getByRole('button', { name: 'Add item' }).click();
    const injection = page.getByTestId('price-Injection');
    await expect(injection).toContainText('₹120');
    await injection.getByRole('button', { name: 'Change price' }).click();
    await injection.getByLabel('New price for Injection (₹)').fill('150');
    await injection.getByRole('button', { name: 'Save price' }).click();
    await expect(injection).toContainText('₹150');
    await expect(prices.getByRole('status')).toContainText('Bills already made keep their price');

    await page.getByRole('link', { name: 'Collections' }).click();
    await expect(page.getByRole('heading', { name: 'Collections', level: 1 })).toBeVisible();
    await expect(page.getByTestId('collections-totals')).toContainText('₹500');
    await expect(page.getByTestId('mode-cash')).toContainText('₹500');
    await expect(page.getByTestId('collection-payments')).toContainText('R00001');
    await expect(page.getByTestId('collection-dues')).toContainText(patient.uhid);
    await expect(page.getByTestId('collection-dues')).toContainText('₹300');
  });
});
