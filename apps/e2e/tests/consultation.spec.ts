import type { Db } from '@dhc/db';
import { expect, setUpFromInvite, test, type Clinic } from '../fixtures';

const today = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

/** An active doctor, a clinic and one walk-in for today in the given status. */
async function walkIn(
  db: Db,
  clinic: Clinic,
  patientIndex: number,
  status: 'checked_in' | 'in_consultation',
) {
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
  });
  const patient = patients[patientIndex]!;
  const now = new Date();
  await db.appointment.create({
    data: {
      organisationId: org.id,
      patientId: patient.id,
      doctorUserId: doctor.id,
      clinicId: place.id,
      consultationTypeId: type.id,
      date: new Date(`${today()}T00:00:00Z`),
      startAt: now,
      endAt: new Date(now.getTime() + 15 * 60_000),
      status,
      source: 'walk_in',
      tokenNumber: 1,
      checkedInAt: now,
      consultationStartedAt: status === 'in_consultation' ? now : null,
      createdByUserId: doctor.id,
    },
  });
  return { patient };
}

test.describe('consultation', () => {
  test('the doctor records the chart, vitals and notes, which autosave', async ({
    page,
    clinic,
    db,
  }) => {
    // Set up first: the invite expects the membership still to be pending.
    await setUpFromInvite(page, clinic.inviteLink('doctor'), 'doctor synthetic passphrase');
    const { patient } = await walkIn(db, clinic, 0, 'in_consultation');

    await page.getByRole('link', { name: 'Queue' }).click();
    await page
      .getByTestId(`appointment-${patient.uhid}`)
      .getByRole('link', { name: 'Consultation' })
      .click();
    await expect(page.getByRole('heading', { name: 'Consultation: Asha Verma' })).toBeVisible();

    // Chart: a patient-reported allergy is labelled unverified.
    const allergies = page.getByTestId('chart-allergies');
    await expect(allergies).toContainText('No allergies recorded');
    await allergies.getByRole('button', { name: 'Add' }).click();
    await allergies.getByLabel('Allergic to').fill('Penicillin');
    await allergies.getByLabel('Reaction (optional)').fill('Rash');
    await allergies.getByLabel('Reported by the patient, not yet verified').check();
    await allergies.getByRole('button', { name: 'Add' }).click();
    await expect(allergies).toContainText('Penicillin · Rash');
    await expect(allergies).toContainText('Patient-reported, unverified');

    // Vitals with BMI.
    await page.getByLabel('Weight (kg)').fill('70');
    await page.getByLabel('Height (cm)').fill('175');
    await page.getByLabel('BP systolic (mmHg)').fill('128');
    await page.getByRole('button', { name: 'Save vitals' }).click();
    await expect(page.getByTestId('bmi')).toContainText('BMI 22.9');

    // Notes: ICD-10 search and a free-text diagnosis.
    await page.getByLabel('Chief complaint').fill('Left shoulder stiffness for a month');
    await page.getByRole('button', { name: 'Add symptom' }).click();
    await page.getByLabel('Symptom', { exact: true }).fill('Painful overhead reach');
    await page.getByLabel('Duration').fill('1 month');
    await page.getByRole('textbox', { name: 'Diagnosis' }).fill('frozen');
    await page.getByRole('option', { name: /M75\.0 Adhesive capsulitis of shoulder/ }).click();
    await page.getByRole('textbox', { name: 'Diagnosis' }).fill('Rotator cuff strain');
    await page.getByRole('textbox', { name: 'Diagnosis' }).press('Enter');
    await page.getByLabel('Plan', { exact: true }).fill('Physiotherapy, review in two weeks');
    await page.getByLabel('Private notes (never printed or shared)').fill('Anxious about surgery');
    await expect(page.getByTestId('save-status')).toContainText('Saved');

    // Everything is there after a reload.
    await page.reload();
    await expect(page.getByLabel('Chief complaint')).toHaveValue(
      'Left shoulder stiffness for a month',
    );
    await expect(page.getByTestId('diagnoses')).toContainText('M75.0 Adhesive capsulitis');
    await expect(page.getByTestId('diagnoses')).toContainText('Rotator cuff strain');
    await expect(page.getByLabel('Symptom', { exact: true })).toHaveValue('Painful overhead reach');
    await expect(page.getByLabel('Plan', { exact: true })).toHaveValue(
      'Physiotherapy, review in two weeks',
    );
    await expect(page.getByLabel('Weight (kg)')).toHaveValue('70');

    // Removing an allergy needs a reason.
    await allergies.getByRole('button', { name: 'Remove' }).click();
    await allergies.getByLabel('Reason for removing').fill('Tolerated amoxicillin last year');
    await allergies.getByRole('button', { name: 'Remove' }).click();
    await expect(allergies).toContainText('No allergies recorded');

    // The follow-up date offers one-tap booking.
    await page.getByLabel('Follow-up date').fill('2030-01-15');
    await expect(page.getByRole('link', { name: 'Book follow-up' })).toHaveAttribute(
      'href',
      new RegExp(`patientId=${patient.id}&date=2030-01-15`),
    );
    await expect(page.getByTestId('save-status')).toContainText('Saved');
  });

  test('front desk records vitals from the queue but cannot open the notes', async ({
    page,
    clinic,
    db,
  }) => {
    const { patient } = await walkIn(db, clinic, 1, 'checked_in');
    // A six-year-old: weight is needed today.
    const sixYearsAgo = new Date(Date.now() - 6.5 * 365 * 24 * 3600_000);
    await db.patient.update({ where: { id: patient.id }, data: { dob: sixYearsAgo } });

    await setUpFromInvite(page, clinic.inviteLink('front_desk'), 'desk synthetic passphrase');
    await page.getByRole('link', { name: 'Queue' }).click();
    const row = page.getByTestId(`appointment-${patient.uhid}`);
    await expect(row.getByRole('link', { name: 'Consultation' })).toHaveCount(0);
    await row.getByRole('link', { name: 'Vitals' }).click();

    await expect(page.getByRole('heading', { name: 'Vitals for Ravi Mehra' })).toBeVisible();
    await expect(page.getByTestId('child-weight')).toBeVisible();
    await page.getByLabel('Pulse (/min)').fill('96');
    await page.getByLabel('Temperature (°C)').fill('37.9');
    await page.getByLabel('Weight (kg)').fill('21.5');
    await page.getByRole('button', { name: 'Save vitals' }).click();
    await expect(page.getByText('Vitals saved')).toBeVisible();
    await expect(page.getByTestId('child-weight')).toHaveCount(0);

    await page.goto(`/clinic/consultations/${(await appointmentOf(db, patient.id)).id}`);
    await expect(page.locator('main [role=alert]')).toContainText('You do not have access');
  });
});

const appointmentOf = (db: Db, patientId: string) =>
  db.appointment.findFirstOrThrow({ where: { patientId } });
