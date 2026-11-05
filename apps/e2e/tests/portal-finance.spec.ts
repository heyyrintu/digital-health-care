import { randomUUID } from 'node:crypto';
import { expect, signInAsPatient, syntheticMobile, test } from '../fixtures';
test('patient recovers a checkout, reads an owned original receipt and opens print/save PDF', async ({
  page,
  db,
  clinic,
}) => {
  const org = await db.organisation.findUniqueOrThrow({ where: { slug: clinic.slug } }),
    doctor = await db.user.findUniqueOrThrow({ where: { email: clinic.email('doctor') } }),
    patient = await db.patient.findFirstOrThrow({ where: { organisationId: org.id } }),
    phone = syntheticMobile();
  await db.membership.updateMany({
    where: { organisationId: org.id, userId: doctor.id },
    data: { status: 'active' },
  });
  await db.patient.update({ where: { id: patient.id }, data: { phone: '+91' + phone } });
  const place = await db.clinic.create({ data: { organisationId: org.id, name: 'Main clinic' } }),
    type = await db.consultationType.create({
      data: {
        organisationId: org.id,
        name: 'Visit',
        mode: 'in_person',
        defaultDurationMin: 15,
        feePaise: 80000,
      },
    }),
    now = new Date(),
    date = new Date(new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10));
  const appointment = await db.appointment.create({
    data: {
      organisationId: org.id,
      patientId: patient.id,
      doctorUserId: doctor.id,
      clinicId: place.id,
      consultationTypeId: type.id,
      date,
      startAt: now,
      endAt: new Date(Date.now() + 900000),
      status: 'checked_in',
      source: 'walk_in',
      tokenNumber: 1,
      createdByUserId: doctor.id,
    },
  });
  const bill = await db.bill.create({
    data: {
      organisationId: org.id,
      appointmentId: appointment.id,
      patientId: patient.id,
      doctorUserId: doctor.id,
      createdByUserId: doctor.id,
      subtotalPaise: 80000,
      totalPaise: 80000,
      status: 'due',
    },
  });
  await db.billItem.create({
    data: {
      organisationId: org.id,
      billId: bill.id,
      kind: 'consultation',
      name: 'Consultation',
      unitPaise: 80000,
      quantity: 1,
      amountPaise: 80000,
      sortOrder: 0,
    },
  });
  const receipt = await db.payment.create({
    data: {
      id: randomUUID(),
      organisationId: org.id,
      billId: bill.id,
      mode: 'cash',
      amountPaise: 80000,
      receiptNumber: 'R-FINANCE-1',
      receivedByUserId: doctor.id,
      receivedAt: now,
    },
  });
  await db.bill.update({ where: { id: bill.id }, data: { paidPaise: 80000, status: 'paid' } });
  await signInAsPatient(page, db, clinic, phone);
  await page.getByRole('checkbox', { name: 'I have read the privacy notice' }).check();
  await page.getByRole('checkbox', { name: 'I accept the terms of use' }).check();
  await page.getByRole('checkbox', { name: /health records/i }).check();
  await page.getByRole('button', { name: 'Accept and continue' }).click();
  let attemptId: string | undefined,
    tries = 0;
  const unpaidId = randomUUID();
  let active = false;
  await page.route('**/v1/portal/bills**', async (route) => {
    const request = route.request();
    if (request.method() === 'POST' && request.url().endsWith('/checkout')) {
      tries++;
      const body = request.postDataJSON();
      expect(body.amountPaise).toBeUndefined();
      if (attemptId) expect(body.id).toBe(attemptId);
      attemptId = body.id;
      if (tries === 1) {
        await route.fulfill({
          status: 503,
          json: {
            error: { code: 'BUSINESS_RULE', message: 'Synthetic provider response unknown' },
          },
        });
        return;
      }
      active = true;
    }
    const row = {
      id: unpaidId,
      appointmentId: appointment.id,
      patient: { id: patient.id, name: patient.name, uhid: patient.uhid },
      visitDate: date.toISOString().slice(0, 10),
      totalPaise: 60000,
      paidPaise: 0,
      balancePaise: 60000,
      refundedPaise: 0,
      netCollectedPaise: 0,
      canPay: true,
      prepaidBookingId: null,
      order: active
        ? {
            id: attemptId,
            status: 'active',
            expiresAt: new Date(Date.now() + 1800000).toISOString(),
            paymentUrl: 'https://checkout.example.test/pay/reference',
          }
        : null,
    };
    await route.fulfill({
      json: request.method() === 'GET' ? { data: [row], nextCursor: null } : row,
    });
  });
  await page.getByRole('navigation').getByRole('link', { name: 'Payments and receipts' }).click();
  await expect(page.getByTestId('portal-bill')).toContainText('₹600');
  await expect(page.getByTestId('portal-receipt')).toContainText('R-FINANCE-1');
  await page.getByRole('button', { name: 'Prepare secure payment' }).click();
  await expect(page.locator('main [role=alert]')).toBeVisible();
  await page.getByRole('button', { name: 'Prepare secure payment' }).click();
  await expect(page.getByRole('link', { name: 'Continue to secure payment' })).toHaveAttribute(
    'href',
    'https://checkout.example.test/pay/reference',
  );
  await page.getByRole('link', { name: 'View receipt', exact: true }).click();
  await expect(page.getByTestId('receipt')).toContainText('R-FINANCE-1');
  await expect(page.getByTestId('receipt')).toContainText('₹800');
  await page.evaluate(() => {
    window.print = () => {
      document.documentElement.dataset.printed = 'true';
    };
  });
  await page.getByRole('button', { name: 'Print or save as PDF' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-printed', 'true');
  // The real API supplies this receipt; the checkout routes above model external provider behavior only.
  expect(await db.payment.count({ where: { billId: bill.id } })).toBe(1);
  expect(receipt.id).toBeTruthy();
});
