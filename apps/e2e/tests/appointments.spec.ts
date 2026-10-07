import type { Db } from '@dhc/db';
import { expect, setUpFromInvite, test, type Clinic } from '../fixtures';

/** IST calendar date `days` from now, `YYYY-MM-DD`. */
const istDay = (days: number) =>
  new Date(Date.now() + (330 + days * 24 * 60) * 60_000).toISOString().slice(0, 10);
/** UTC instant of an IST wall-clock time. */
const istAt = (date: string, time: string) =>
  new Date(new Date(`${date}T${time}:00.000Z`).getTime() - 330 * 60_000);

/** A clinic, a 20-minute schedule 09:00–10:00 every day, and an active doctor. */
async function schedule(db: Db, clinic: Clinic) {
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
      defaultDurationMin: 20,
      feePaise: 80000,
    },
  });
  const hours = [{ start: '09:00', end: '10:00' }];
  await db.availabilityVersion.create({
    data: {
      organisationId: org.id,
      doctorUserId: doctor.id,
      clinicId: place.id,
      consultationTypeId: type.id,
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
      weekly: {
        mon: hours,
        tue: hours,
        wed: hours,
        thu: hours,
        fri: hours,
        sat: hours,
        sun: hours,
      },
      slotMinutes: 20,
      createdByUserId: doctor.id,
    },
  });
  const patients = await db.patient.findMany({
    where: { organisationId: org.id },
    orderBy: { uhid: 'asc' },
  });
  return { org, doctor, place, type, patients };
}

test.describe('appointments', () => {
  test('front desk books from the patient page, reschedules and cancels', async ({
    page,
    clinic,
    db,
  }) => {
    const { org, doctor, place, type, patients } = await schedule(db, clinic);
    const day = istDay(1);
    // Someone else already has 09:00.
    await db.appointment.create({
      data: {
        organisationId: org.id,
        patientId: patients[1]!.id,
        doctorUserId: doctor.id,
        clinicId: place.id,
        consultationTypeId: type.id,
        date: new Date(`${day}T00:00:00Z`),
        startAt: istAt(day, '09:00'),
        endAt: istAt(day, '09:20'),
        status: 'confirmed',
        source: 'front_desk',
        tokenNumber: 1,
        createdByUserId: doctor.id,
      },
    });

    await setUpFromInvite(page, clinic.inviteLink('front_desk'), 'desk synthetic passphrase');
    await page.getByRole('link', { name: 'Asha Verma' }).click();
    await expect(page.getByText('No appointments yet.')).toBeVisible();
    await page.getByRole('link', { name: 'Book appointment' }).click();

    await expect(page.getByTestId('booking-patient')).toContainText('Asha Verma');
    await page.getByLabel('Date', { exact: true }).fill(day);
    await expect(page.getByTestId('slot-09:00')).toBeDisabled();
    await expect(page.getByTestId('slot-09:00')).toContainText('taken');
    await page.getByTestId('slot-09:20').click();
    await page.getByLabel('Reason for visit (optional)').fill('Knee pain');
    await page.getByRole('button', { name: 'Book 09:20' }).click();

    await expect(page).toHaveURL(new RegExp(`/clinic/appointments\\?date=${day}`));
    const row = page.getByTestId('appointment-E2E-000001');
    await expect(row).toContainText('09:20');
    await expect(row).toContainText('Knee pain');
    await expect(row.getByTestId('appointment-status')).toHaveText('Booked');
    await expect(row.locator('.appt-token')).toHaveText('2');

    // Move it to 09:40.
    await row.getByRole('link', { name: 'Reschedule' }).click();
    await expect(page.getByTestId('current-booking')).toContainText('09:20');
    await page.getByTestId('slot-09:40').click();
    await page.getByRole('button', { name: 'Move to 09:40' }).click();
    const rows = page.getByTestId('appointment-E2E-000001');
    await expect(rows).toHaveCount(2);
    await expect(rows.filter({ hasText: '09:20' })).toContainText('Rescheduled');
    const moved = rows.filter({ hasText: '09:40' });
    await expect(moved.getByTestId('appointment-status')).toHaveText('Booked');

    // Cancel needs a reason.
    await moved.getByRole('button', { name: 'Cancel appointment' }).click();
    await moved.getByLabel('Reason for cancelling').fill('Patient travelling');
    await moved.getByRole('button', { name: 'Cancel appointment' }).click();
    await expect(moved.getByTestId('appointment-status')).toHaveText('Cancelled');
    await expect(moved).toContainText('Patient travelling');

    // The patient page lists all three states.
    await page.getByRole('link', { name: 'Asha Verma' }).first().click();
    await expect(page.getByTestId('patient-appointments').locator('li')).toHaveCount(2);
  });

  test('front desk adds a walk-in; overbooking needs the switch', async ({ page, clinic, db }) => {
    const { org, doctor, place, type, patients } = await schedule(db, clinic);
    const day = istDay(1);
    await db.appointment.create({
      data: {
        organisationId: org.id,
        patientId: patients[0]!.id,
        doctorUserId: doctor.id,
        clinicId: place.id,
        consultationTypeId: type.id,
        date: new Date(`${day}T00:00:00Z`),
        startAt: istAt(day, '09:00'),
        endAt: istAt(day, '09:20'),
        status: 'confirmed',
        source: 'front_desk',
        tokenNumber: 1,
        createdByUserId: doctor.id,
      },
    });

    await setUpFromInvite(page, clinic.inviteLink('front_desk'), 'desk synthetic passphrase');
    await page.getByRole('link', { name: 'Appointments' }).click();
    await page.getByRole('link', { name: 'Add walk-in' }).click();
    await page.getByPlaceholder('Find patient by name, mobile or UHID').fill('Ravi');
    await page.getByRole('button', { name: 'Search' }).click();
    await page.getByRole('button', { name: 'Choose' }).click();
    await page.getByRole('button', { name: 'Add as walk-in today' }).click();

    const walkIn = page.getByTestId('appointment-E2E-000002');
    await expect(walkIn.getByTestId('appointment-status')).toHaveText('Checked in');
    await expect(walkIn).toContainText('Walk-in');

    // Overbook Kamla into the taken 09:00 slot tomorrow.
    await page.goto(`/clinic/appointments/new?patientId=${patients[2]!.id}&date=${day}`);
    await expect(page.getByTestId('slot-09:00')).toBeDisabled();
    await page.getByLabel('Allow booking into a taken slot (overbook)').check();
    await page.getByTestId('slot-09:00').click();
    await page.getByRole('button', { name: 'Book 09:00' }).click();
    const extra = page.getByTestId('appointment-E2E-000003');
    await expect(extra).toContainText('Overbooked');
    await expect(extra.locator('.appt-token')).toHaveText('2');
  });

  test('the doctor runs a checked-in patient’s consultation to completion', async ({
    page,
    clinic,
    db,
  }) => {
    // Set up first: the invite expects the membership still to be pending.
    await setUpFromInvite(page, clinic.inviteLink('doctor'), 'doctor synthetic passphrase');
    const { org, doctor, place, type, patients } = await schedule(db, clinic);
    const today = istDay(0);
    await db.appointment.create({
      data: {
        organisationId: org.id,
        patientId: patients[0]!.id,
        doctorUserId: doctor.id,
        clinicId: place.id,
        consultationTypeId: type.id,
        date: new Date(`${today}T00:00:00Z`),
        startAt: new Date(),
        endAt: new Date(Date.now() + 20 * 60_000),
        status: 'checked_in',
        source: 'walk_in',
        tokenNumber: 1,
        checkedInAt: new Date(),
        createdByUserId: doctor.id,
      },
    });

    await page.getByRole('link', { name: 'Appointments' }).click();
    const row = page.getByTestId('appointment-E2E-000001');
    await row.getByRole('button', { name: 'Start consultation' }).click();
    await expect(row.getByTestId('appointment-status')).toHaveText('In consultation');
    await row.getByRole('button', { name: 'Complete' }).click();
    await expect(row.getByTestId('appointment-status')).toHaveText('Completed');
    await expect(row.getByRole('button')).toHaveCount(0);
  });
});
