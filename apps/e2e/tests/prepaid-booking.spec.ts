import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import type { Db } from '@dhc/db';
import { expect, signInAsPatient, syntheticMobile, test, type Clinic } from '../fixtures';
async function setup(
  page: Page,
  db: Db,
  clinic: Clinic,
  mode: 'in_person' | 'audio' | 'video' = 'in_person',
) {
  const org = await db.organisation.findUniqueOrThrow({ where: { slug: clinic.slug } }),
    doctor = await db.user.findUniqueOrThrow({ where: { email: clinic.email('doctor') } });
  await db.membership.updateMany({
    where: { organisationId: org.id, userId: doctor.id },
    data: { status: 'active' },
  });
  const person = await db.patient.findFirstOrThrow({ where: { organisationId: org.id } }),
    phone = syntheticMobile();
  await db.patient.update({
    where: { id: person.id },
    data: { phone: '+91' + phone, name: 'Synthetic prepaid patient' },
  });
  await signInAsPatient(page, db, clinic, phone);
  await page.getByRole('checkbox', { name: 'I have read the privacy notice' }).check();
  await page.getByRole('checkbox', { name: 'I accept the terms of use' }).check();
  await page.getByRole('checkbox', { name: /health records/i }).check();
  await page.getByRole('button', { name: 'Accept and continue' }).click();
  const clinicId = randomUUID(),
    typeId = randomUUID(),
    appointmentId = randomUUID();
  let reservationId = randomUUID(),
    state = 'held';
  const tomorrow = new Date(Date.now() + 330 * 60000 + 86400000).toISOString().slice(0, 10),
    start = new Date(tomorrow + 'T10:00:00+05:30').toISOString(),
    end = new Date(Date.parse(start) + 15 * 60000).toISOString();
  const view = () => ({
    id: reservationId,
    appointmentId,
    appointmentStatus:
      state === 'confirmed' ? 'confirmed' : state === 'released' ? 'cancelled' : 'pending',
    state,
    expiresAt: new Date(Date.now() + 30 * 60000).toISOString(),
    amountPaise: 80000,
    orderStatus: state === 'confirmed' ? 'paid' : state === 'released' ? 'terminated' : 'active',
    paymentUrl: state === 'held' ? 'https://checkout.example.test/pay/reference' : null,
    providerAvailable: true,
  });
  await page.route('**/v1/portal/booking-options*', (route) =>
    route.fulfill({
      json: {
        doctors: [{ userId: doctor.id, displayName: 'Synthetic doctor', publicSlug: null }],
        clinics: [{ id: clinicId, name: 'Main clinic', address: null }],
        consultationTypes: [
          {
            id: typeId,
            name: 'Prepaid visit',
            mode,
            defaultDurationMin: 15,
            feePaise: 80000,
            requiresPrepayment: true,
          },
        ],
        horizonDays: 30,
        cancelCutoffMinutes: 120,
        maxActiveBookings: 3,
      },
    }),
  );
  await page.route('**/v1/portal/slots*', (route) => {
    const date = new URL(route.request().url()).searchParams.get('date');
    return route.fulfill({
      json: {
        date,
        slots:
          date === tomorrow
            ? [{ start, end, startTime: '10:00', endTime: '10:15', available: true }]
            : [],
      },
    });
  });
  await page.route('**/v1/portal/prepaid-bookings**', async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (path.endsWith('/prepaid-bookings') && request.method() === 'POST') {
      const body = request.postDataJSON();
      expect(body.amountPaise).toBeUndefined();
      expect(body.patientId).toBe(person.id);
      reservationId = body.id;
    }
    if (path.endsWith('/check')) state = 'confirmed';
    if (path.endsWith('/close')) state = 'released';
    await route.fulfill({ json: view() });
  });
  await page.goto('/app/book');
  await page.getByRole('group', { name: 'Date' }).getByRole('button').nth(1).click();
  await page.locator('[data-slot="10:00"]').click();
  await expect(page.getByText('Booking fee ₹800.')).toBeVisible();
  await expect(page.getByText('Fee ₹800, paid at the clinic.')).toHaveCount(0);
  await page.getByRole('button', { name: 'Reserve slot and continue to payment' }).click();
  await expect(page.getByRole('status')).toContainText('Payment pending');
  await expect(
    page.getByText(
      'This slot is reserved while payment is pending. It is not a confirmed appointment yet.',
    ),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Continue to secure payment' })).toHaveAttribute(
    'href',
    'https://checkout.example.test/pay/reference',
  );
}
test('patient reserves a prepaid slot, sees the checkout link and confirms from server status', async ({
  page,
  db,
  clinic,
}) => {
  await setup(page, db, clinic);
  await page.getByRole('button', { name: 'Check payment and booking' }).click();
  await expect(page.getByText('Your booking is confirmed.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Continue to secure payment' })).toHaveCount(0);
});
test('patient explicitly confirms closing an unpaid reservation', async ({ page, db, clinic }) => {
  await setup(page, db, clinic);
  await page.getByRole('button', { name: 'Close unpaid reservation', exact: true }).click();
  await page
    .getByRole('group', { name: /Close the payment request/ })
    .getByRole('button', { name: 'Close unpaid reservation' })
    .click();
  await expect(page.getByRole('status')).toHaveText('Reservation released');
  await expect(page.getByRole('link', { name: 'Continue to secure payment' })).toHaveCount(0);
});

for (const mode of ['audio', 'video'] as const) {
  for (const width of [390, 1280]) {
    test(`patient reserves a prepaid ${mode} visit with explicit payment status (${width}px)`, async ({
      page,
      db,
      clinic,
    }) => {
      await page.setViewportSize({ width, height: 1000 });
      await setup(page, db, clinic, mode);
      await expect(page.getByText(/Arrange payment with the clinic/)).toHaveCount(0);
      await page.getByRole('button', { name: 'Check payment and booking' }).click();
      await expect(page.getByText('Your booking is confirmed.')).toBeVisible();
      await expect(page.getByRole('link', { name: 'Continue to secure payment' })).toHaveCount(0);
    });
  }
}
