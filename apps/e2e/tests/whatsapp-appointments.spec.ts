import { randomUUID } from 'node:crypto';
import { expect, setUpFromInvite, syntheticMobile, signInAsPatient, test } from '../fixtures';

test('staff record explicit appointment consent, new bookings queue messages, and revocation cancels reminders', async ({
  page,
  browser,
  clinic,
  db,
}) => {
  test.skip(
    process.env.E2E_WHATSAPP !== '1',
    'Enable synthetic appointment messaging with E2E_WHATSAPP=1',
  );
  const org = await db.organisation.findUniqueOrThrow({ where: { slug: clinic.slug } });
  const patient = await db.patient.findFirstOrThrow({ where: { organisationId: org.id } });
  await db.patient.update({
    where: { id: patient.id },
    data: { phone: '+91' + syntheticMobile() },
  });
  await setUpFromInvite(page, clinic.inviteLink('clinic_admin'), 'admin synthetic passphrase');
  await page.goto(`/clinic/patients/${patient.id}`);
  const card = page.getByTestId('whatsapp-preference');
  await expect(card.getByRole('status')).toHaveText('Appointment messages are off.');
  await expect(card.getByRole('button', { name: 'Enable appointment messages' })).toBeDisabled();
  await card.getByRole('checkbox').check();
  await card.getByRole('button', { name: 'Enable appointment messages' }).click();
  await expect(card.getByRole('status')).toHaveText('Appointment messages are on.');

  const place = await db.clinic.create({
    data: { organisationId: org.id, name: 'Synthetic Clinic' },
  });
  const doctor = await db.user.findUniqueOrThrow({ where: { email: clinic.email('doctor') } });
  const type = await db.consultationType.create({
    data: {
      organisationId: org.id,
      name: 'Clinic visit',
      mode: 'in_person',
      defaultDurationMin: 15,
      feePaise: 80000,
    },
  });
  const startAt = new Date(Date.now() + 48 * 3600_000);
  const a = await db.appointment.create({
    data: {
      id: randomUUID(),
      organisationId: org.id,
      patientId: patient.id,
      doctorUserId: doctor.id,
      clinicId: place.id,
      consultationTypeId: type.id,
      date: new Date(startAt.toISOString().slice(0, 10) + 'T00:00:00Z'),
      startAt,
      endAt: new Date(startAt.getTime() + 900_000),
      status: 'confirmed',
      source: 'front_desk',
      tokenNumber: 1,
      createdByUserId: doctor.id,
    },
  });
  const queued = await db.whatsAppDelivery.findMany({ where: { appointmentId: a.id } });
  expect(queued).toHaveLength(2);
  await page.getByRole('link', { name: 'WhatsApp delivery', exact: true }).click();
  await expect(
    page.getByRole('cell', { name: 'Appointment confirmation', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Appointment reminder', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Scheduled', exact: true })).toHaveCount(2);

  // A patient can revoke on the consent gate, without accepting health-data consent.
  const context = await browser.newContext({ baseURL: 'http://localhost:3300' });
  const patientPage = await context.newPage();
  const currentPatient = await db.patient.findUniqueOrThrow({ where: { id: patient.id } });
  await signInAsPatient(patientPage, db, clinic, currentPatient.phone!.slice(3));
  await patientPage
    .getByTestId('whatsapp-preference')
    .getByRole('button', { name: 'Turn off appointment messages' })
    .click();
  await expect(patientPage.getByTestId('whatsapp-preference')).toHaveCount(0);
  await context.close();
  await page.goto(`/clinic/patients/${patient.id}`);
  await expect(card.getByRole('status')).toHaveText('Appointment messages are off.');
  expect(
    (await db.whatsAppDelivery.findMany({ where: { appointmentId: a.id } })).every(
      (r) => r.status === 'skipped',
    ),
  ).toBe(true);
});
