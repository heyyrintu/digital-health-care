import { expect, pageAlert, setUpFromInvite, test } from '../fixtures';
import type { Db } from '@dhc/db';
import type { Clinic } from '../fixtures';

const WEEK = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** Tomorrow's date in IST, `YYYY-MM-DD`: never affected by the time of day the test runs. */
const tomorrow = () => new Date(Date.now() + (330 + 24 * 60) * 60_000).toISOString().slice(0, 10);

async function clinicSetup(db: Db, clinic: Clinic) {
  const org = await db.organisation.findUniqueOrThrow({ where: { slug: clinic.slug } });
  const place = await db.clinic.create({ data: { organisationId: org.id, name: 'Main clinic' } });
  const type = await db.consultationType.create({
    data: {
      organisationId: org.id,
      name: 'In-person consultation',
      mode: 'in_person',
      defaultDurationMin: 15,
      feePaise: 80000,
    },
  });
  return { org, place, type };
}

test.describe('doctor availability', () => {
  test('clinic admin adds a clinic, a consultation type and booking rules', async ({
    page,
    clinic,
  }) => {
    await setUpFromInvite(page, clinic.inviteLink('clinic_admin'), 'admin synthetic passphrase');
    const card = page.locator('section', {
      has: page.getByRole('heading', { name: 'Clinics and consultations' }),
    });
    await expect(card).toContainText('No clinics yet');

    await card.getByLabel('Clinic name').fill('Main clinic');
    await card.getByLabel('Address (optional)').fill('1 Synthetic Marg, Delhi');
    await card.getByRole('button', { name: 'Add clinic' }).click();
    await expect(page.getByTestId('clinic-Main clinic')).toContainText('1 Synthetic Marg, Delhi');

    await card.getByLabel('Name', { exact: true }).fill('Video consultation');
    await card.getByLabel('Mode').selectOption('video');
    await card.getByLabel('Fee (₹)').fill('700');
    await card.getByLabel('Patients pay when booking').check();
    await card.getByRole('button', { name: 'Add consultation type' }).click();
    await expect(page.getByTestId('type-Video consultation')).toContainText('Video call');
    await expect(page.getByTestId('type-Video consultation')).toContainText('₹700');
    await expect(page.getByTestId('type-Video consultation')).toContainText('Paid at booking');

    await card.getByLabel('Patients can book up to (days ahead)').fill('14');
    await card.getByRole('button', { name: 'Save' }).click();
    await expect(card.getByRole('status')).toHaveText('Booking rules saved.');
  });

  test('a doctor sets a weekly schedule, takes leave, and sees the slots change', async ({
    page,
    clinic,
    db,
  }) => {
    await clinicSetup(db, clinic);
    await setUpFromInvite(page, clinic.inviteLink('doctor'), 'doctor synthetic passphrase');
    await page.getByRole('link', { name: 'Availability' }).click();
    await expect(page.getByRole('heading', { name: 'Doctor availability' })).toBeVisible();
    await expect(page.getByText('No weekly schedule yet.')).toBeVisible();

    // 10:00–13:00 every day, then a second Monday session that is still empty.
    for (const day of WEEK) {
      await page.getByRole('button', { name: `Add session (${day})` }).click();
    }
    await page.getByRole('button', { name: 'Add session (Monday)' }).click();
    await page.getByRole('button', { name: 'Save schedule' }).click();
    await expect(pageAlert(page)).toContainText('fit at least one slot');
    await expect(page.getByTestId('day-mon')).toContainText('fit at least one slot');

    await page.getByLabel('Monday session 2 starts').fill('17:00');
    await page.getByLabel('Monday session 2 ends').fill('18:00');
    await page.getByRole('button', { name: 'Save schedule' }).click();
    await expect(page.getByRole('status')).toHaveText('Saved.');
    await expect(page.getByTestId('schedule-current')).toContainText('10:00–13:00, 17:00–18:00');

    const day = tomorrow();
    await page.getByLabel('Date', { exact: true }).fill(day);
    await expect(page.getByTestId('slot-10:00')).toBeVisible();
    await expect(page.getByTestId('slot-12:45')).toBeVisible();
    await expect(page.getByTestId('slot-13:00')).toHaveCount(0);

    // Leave tomorrow closes the day; removing it brings the slots back.
    await page.getByLabel('Type', { exact: true }).selectOption('leave');
    await page.getByLabel('From', { exact: true }).fill(day);
    await page.getByLabel('Note (optional)').fill('Conference');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.getByTestId('exceptions')).toContainText('Conference');
    await expect(page.getByTestId('slots')).toHaveText('The doctor is on leave.');

    await page.getByTestId('exceptions').getByRole('button', { name: 'Remove' }).click();
    await expect(page.getByText('Nothing planned.')).toBeVisible();
    await expect(page.getByTestId('slot-10:00')).toBeVisible();
  });

  test('front desk checks slots but cannot change the schedule', async ({ page, clinic, db }) => {
    const { org, place, type } = await clinicSetup(db, clinic);
    const doctor = await db.user.findUniqueOrThrow({ where: { email: clinic.email('doctor') } });
    await db.membership.updateMany({
      where: { organisationId: org.id, userId: doctor.id },
      data: { status: 'active' },
    });
    const allWeek = [{ start: '09:00', end: '10:00' }];
    await db.availabilityVersion.create({
      data: {
        organisationId: org.id,
        doctorUserId: doctor.id,
        clinicId: place.id,
        consultationTypeId: type.id,
        effectiveFrom: new Date('2026-01-01T00:00:00Z'),
        weekly: {
          mon: allWeek,
          tue: allWeek,
          wed: allWeek,
          thu: allWeek,
          fri: allWeek,
          sat: allWeek,
          sun: allWeek,
        },
        slotMinutes: 20,
        createdByUserId: doctor.id,
      },
    });

    await setUpFromInvite(page, clinic.inviteLink('front_desk'), 'desk synthetic passphrase');
    await page.getByRole('link', { name: 'Availability' }).click();
    await expect(page.getByLabel('Doctor', { exact: true })).toHaveValue(doctor.id);
    await page.getByLabel('Date', { exact: true }).fill(tomorrow());
    await expect(page.getByTestId('slot-count')).toHaveText('3 of 3 slots open');
    await expect(page.getByTestId('schedule-current')).toContainText('20-minute slots');
    await expect(page.getByRole('button', { name: 'Save schedule' })).toHaveCount(0);
    await expect(page.getByLabel('Type', { exact: true })).toHaveCount(0);
  });
});
