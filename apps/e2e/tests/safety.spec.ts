import type { Db } from '@dhc/db';
import { expect, setUpFromInvite, test, type Clinic } from '../fixtures';

const istDay = (days = 0) =>
  new Date(Date.now() + (330 + days * 24 * 60) * 60_000).toISOString().slice(0, 10);

/**
 * An active doctor and Asha in consultation today, with a penicillin allergy and warfarin
 * on her chart. Drug facts come from the synthetic sample (illustrative, not clinical).
 */
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
  const patient = await db.patient.findFirstOrThrow({
    where: { organisationId: org.id },
    orderBy: { uhid: 'asc' },
  });
  const chart = { organisationId: org.id, patientId: patient.id, recordedByUserId: doctor.id };
  await db.allergy.create({ data: { ...chart, substance: 'Penicillin', source: 'doctor' } });
  await db.currentMedication.create({
    data: { ...chart, name: 'Warfarin 5 mg', source: 'patient' },
  });
  const startAt = new Date();
  const visit = await db.appointment.create({
    data: {
      organisationId: org.id,
      patientId: patient.id,
      doctorUserId: doctor.id,
      clinicId: place.id,
      consultationTypeId: type.id,
      date: new Date(`${istDay(0)}T00:00:00Z`),
      startAt,
      endAt: new Date(startAt.getTime() + 15 * 60_000),
      status: 'in_consultation',
      source: 'walk_in',
      tokenNumber: 1,
      checkedInAt: startAt,
      consultationStartedAt: startAt,
      createdByUserId: doctor.id,
    },
  });
  return { visit };
}

test.describe('safety checks', () => {
  test('a block that cannot be overridden, and a warning acknowledged with a reason', async ({
    page,
    clinic,
    db,
  }) => {
    await setUpFromInvite(page, clinic.inviteLink('doctor'), 'doctor synthetic passphrase');
    const { visit } = await setUp(db, clinic);
    await page.goto(`/clinic/consultations/${visit.id}`);
    const rx = page.getByTestId('prescription');
    const search = rx.getByLabel('Add medicine: search name or composition');

    // Amoxicillin with a recorded penicillin allergy: a block with no override.
    await search.fill('amoxi');
    await rx.getByRole('option', { name: /^Amoxicillin 500/ }).click();
    const amox = rx.getByTestId('rx-line-0');
    await amox.getByLabel('Frequency').fill('1-1-1');
    await expect(rx.getByTestId('safety-banner')).toContainText('Blocking alerts: 1.');
    const block = amox.locator('[data-rule="SR-02"]');
    await expect(block).toContainText(
      'Block: Amoxicillin is a Penicillin, the class of the recorded allergy “Penicillin”.',
    );
    await expect(block).toContainText('Change the prescription to clear this.');
    await expect(block.getByRole('button')).toHaveCount(0);

    // Removing the line clears it.
    await amox.getByRole('button', { name: /Remove/ }).click();
    await expect(rx.getByTestId('safety-banner')).toHaveCount(0);

    // Ibuprofen with warfarin (patient-reported): a warning that needs a reason.
    await search.fill('ibupro');
    await rx.getByRole('option', { name: /^Ibuprofen 400/ }).click();
    const ibu = rx.getByTestId('rx-line-0');
    await ibu.getByLabel('Frequency').fill('1-0-1');
    const warning = ibu.locator('[data-rule="SR-05"]');
    await expect(warning).toContainText(
      'Warning: Major interaction: Ibuprofen with Warfarin (Warfarin 5 mg).',
    );
    await expect(warning).toContainText('Patient-reported, not verified');
    await expect(rx.getByTestId('safety-banner')).toContainText('Warnings to acknowledge: 1.');

    await warning.getByRole('button', { name: 'Acknowledge' }).click();
    await expect(warning).toContainText('Give a reason.');
    await warning.getByLabel('Reason').fill('Short course; INR check booked');
    await warning.getByRole('button', { name: 'Acknowledge' }).click();
    await expect(warning).toContainText('Acknowledged: Short course; INR check booked');
    await expect(rx.getByTestId('safety-banner')).not.toContainText('Warnings to acknowledge');

    // The answer is kept.
    await page.reload();
    await expect(rx.getByTestId('rx-line-0').locator('[data-rule="SR-05"]')).toContainText(
      'Acknowledged: Short course; INR check booked',
    );
    const row = await db.safetyAlert.findFirstOrThrow({ where: { ruleId: 'SR-05' } });
    expect(row.action).toBe('acknowledged');
    expect(await db.safetyAlert.findFirstOrThrow({ where: { ruleId: 'SR-02' } })).toMatchObject({
      action: 'changed',
    });
  });
});
