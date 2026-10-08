import type { Db } from '@dhc/db';
import { expect, setUpFromInvite, test, type Clinic } from '../fixtures';

const today = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

/** Two visits today (one completed, one no-show) and a chart view by the doctor. */
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
    },
  });
  const patients = await db.patient.findMany({
    where: { organisationId: org.id },
    orderBy: { uhid: 'asc' },
    take: 2,
  });
  const now = new Date();
  for (const [i, status] of (['completed', 'no_show'] as const).entries()) {
    await db.appointment.create({
      data: {
        organisationId: org.id,
        patientId: patients[i]!.id,
        doctorUserId: doctor.id,
        clinicId: place.id,
        consultationTypeId: type.id,
        date: new Date(`${today()}T00:00:00Z`),
        startAt: new Date(now.getTime() + i * 15 * 60_000),
        endAt: new Date(now.getTime() + (i + 1) * 15 * 60_000),
        status,
        source: 'front_desk',
        tokenNumber: i + 1,
        createdByUserId: doctor.id,
      },
    });
  }
  await db.auditLog.create({
    data: {
      organisationId: org.id,
      actorUserId: doctor.id,
      action: 'chart.viewed',
      entityType: 'patient',
      entityId: patients[0]!.id,
    },
  });
}

test.describe('clinic admin dashboard', () => {
  test('shows the clinic’s figures and a filterable audit log', async ({ page, clinic, db }) => {
    await setUp(db, clinic);
    await setUpFromInvite(page, clinic.inviteLink('clinic_admin'), 'admin synthetic passphrase');

    const figures = page.getByTestId('clinic-figures');
    await figures.getByRole('button', { name: 'Today' }).click();
    await expect(figures.getByRole('button', { name: 'Today' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(figures.getByText('Appointments', { exact: true })).toBeVisible();
    await expect(figures.getByText('No-shows (50%)')).toBeVisible();
    // Seven days: a row per day, today first.
    await figures.getByRole('button', { name: 'Last 7 days' }).click();
    await expect(page.getByTestId('figures-by-day').locator('tbody tr')).toHaveCount(7);

    await page.getByRole('link', { name: 'Audit log' }).click();
    await expect(page.getByRole('heading', { name: 'Audit log', level: 1 })).toBeVisible();
    const entries = page.getByTestId('audit-entries');
    await expect(entries).toContainText('chart.viewed');
    await expect(entries).toContainText('Dr. Synthetic');

    await page.getByLabel('Area').selectOption({ label: 'Sign-in' });
    await expect(entries).not.toContainText('chart.viewed');
    await expect(entries).toContainText('Clinic Admin');

    await page.getByRole('button', { name: 'Clear filters' }).click();
    await page.getByLabel('Staff member').selectOption({ label: 'Dr. Synthetic' });
    await expect(entries.locator('tbody tr')).toHaveCount(1);
    await expect(entries).toContainText('chart.viewed');
    // Patients are shown by record ID, never by name.
    await expect(entries).not.toContainText('Asha');
  });
});
