import { randomUUID } from 'node:crypto';
import type { Db } from '@dhc/db';
import { expect, setUpFromInvite, test, type Clinic } from '../fixtures';

const istDay = (days = 0) =>
  new Date(Date.now() + (330 + days * 24 * 60) * 60_000).toISOString().slice(0, 10);

/** An active doctor, a clinic and Asha in consultation today. */
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
  const visit = (day: number, status: 'in_consultation' | 'completed', tokenNumber: number) => {
    const startAt = new Date(Date.now() + day * 24 * 3600_000);
    return db.appointment.create({
      data: {
        organisationId: org.id,
        patientId: patient.id,
        doctorUserId: doctor.id,
        clinicId: place.id,
        consultationTypeId: type.id,
        date: new Date(`${istDay(day)}T00:00:00Z`),
        startAt,
        endAt: new Date(startAt.getTime() + 15 * 60_000),
        status,
        source: 'walk_in',
        tokenNumber,
        checkedInAt: startAt,
        consultationStartedAt: startAt,
        createdByUserId: doctor.id,
      },
    });
  };
  return { org, doctor, patient, visit };
}

test.describe('prescription builder', () => {
  test('the doctor adds medicines, a free-text line and a taper, with remarks in English and Hindi', async ({
    page,
    clinic,
    db,
  }) => {
    await setUpFromInvite(page, clinic.inviteLink('doctor'), 'doctor synthetic passphrase');
    const { visit } = await setUp(db, clinic);
    const today = await visit(0, 'in_consultation', 1);
    await page.goto(`/clinic/consultations/${today.id}`);

    const rx = page.getByTestId('prescription');
    await expect(rx).toContainText('No medicines yet.');
    await rx.getByLabel('Add medicine: search name or composition').fill('parac');
    await rx.getByRole('option', { name: /^Paracetamol 650/ }).click();
    const first = rx.getByTestId('rx-line-0');
    await expect(first.getByLabel('Dose')).toHaveValue('1 tablet');
    await first.getByLabel('Frequency').fill('1-0-1');
    await expect(first.getByTestId('rx-remarks')).toHaveText(
      'Take 1 tablet twice a day, after breakfast and dinner, for 5 days.',
    );

    // A medicine that is not in the list.
    await rx.getByLabel('Add medicine: search name or composition').fill('Knee cap support');
    await rx.getByRole('option', { name: /Add “Knee cap support”/ }).click();
    await expect(rx.getByTestId('rx-line-1')).toContainText('Not in medicine list');

    // A tapering course.
    await rx.getByLabel('Add medicine: search name or composition').fill('predni');
    await rx.getByRole('option', { name: /^Prednisolone 10/ }).click();
    const taper = rx.getByTestId('rx-line-2');
    await taper.getByLabel('Dose').fill('2 tablets');
    await taper.getByLabel('Frequency').fill('OD');
    await taper.getByRole('button', { name: 'Add taper step' }).click();
    await taper.getByLabel('Dose').nth(1).fill('1 tablet');
    await taper.getByLabel('Frequency').nth(1).fill('OD');
    await expect(taper.getByTestId('rx-remarks')).toHaveText(
      'Take 2 tablets once a day, after food, for 5 days, then 1 tablet once a day, after food, for 5 days.',
    );

    // Hindi remarks.
    await rx.getByLabel('Remarks language').selectOption('hi');
    await expect(first.getByTestId('rx-remarks')).toHaveText(
      '1 गोली दिन में दो बार, नाश्ते और रात के खाने के बाद, 5 दिन तक लें।',
    );
    await expect(rx.getByTestId('rx-save-status')).toHaveText('Saved');

    // Everything is kept after a reload.
    await page.reload();
    await expect(rx.getByTestId('rx-line-0')).toContainText('Paracetamol 650');
    await expect(rx.getByTestId('rx-line-2').getByLabel('Dose').nth(1)).toHaveValue('1 tablet');
    await expect(rx.getByLabel('Remarks language')).toHaveValue('hi');

    // Edited remarks are printed as written.
    await rx.getByTestId('rx-line-1').getByRole('button', { name: 'Edit remarks' }).click();
    await rx.getByTestId('rx-line-1').getByLabel('Remarks (printed)').fill('Wear during the day.');
    await rx.getByLabel('Template name').fill('Knee OA');
    await rx.getByRole('button', { name: 'Save as template' }).click();
    await expect(rx).toContainText('Template “Knee OA” saved.');
    await expect(rx.getByTestId('rx-save-status')).toHaveText('Saved');
    await page.reload();
    await expect(rx.getByTestId('rx-line-1').getByLabel('Remarks (printed)')).toHaveValue(
      'Wear during the day.',
    );
  });

  test('repeat last and templates add lines', async ({ page, clinic, db }) => {
    await setUpFromInvite(page, clinic.inviteLink('doctor'), 'doctor synthetic passphrase');
    const { org, doctor, patient, visit } = await setUp(db, clinic);
    const earlier = await visit(-14, 'completed', 1);
    const prescription = await db.prescription.create({
      data: {
        organisationId: org.id,
        appointmentId: earlier.id,
        patientId: patient.id,
        doctorUserId: doctor.id,
      },
    });
    await db.prescriptionItem.create({
      data: {
        id: randomUUID(),
        organisationId: org.id,
        prescriptionId: prescription.id,
        name: 'Etoricoxib 90',
        composition: 'Etoricoxib 90 mg',
        form: 'tablet',
        route: 'oral',
        timing: 'after_food',
        steps: [{ dose: '1 tablet', frequency: 'OD', durationValue: 10, durationUnit: 'days' }],
        remarks: 'Take 1 tablet once a day, after food, for 10 days.',
        sortOrder: 0,
      },
    });
    const template = {
      medicineId: null,
      name: 'Pantoprazole 40',
      composition: 'Pantoprazole 40 mg',
      form: 'tablet',
      route: 'oral',
      timing: 'before_food',
      steps: [{ dose: '1 tablet', frequency: '1-0-0', durationValue: 10, durationUnit: 'days' }],
      quantity: null,
      instructions: null,
      remarks: '',
      remarksEdited: false,
    };
    await db.prescriptionTemplate.create({
      data: {
        organisationId: org.id,
        doctorUserId: doctor.id,
        name: 'Stomach cover',
        items: [template],
      },
    });
    const today = await visit(0, 'in_consultation', 2);

    await page.goto(`/clinic/consultations/${today.id}`);
    const rx = page.getByTestId('prescription');
    await rx.getByRole('button', { name: 'Repeat last' }).click();
    await expect(rx).toContainText(`Added 1 medicines from ${istDay(-14)}.`);
    await expect(rx.getByTestId('rx-line-0')).toContainText('Etoricoxib 90');

    await rx.getByLabel('Templates').selectOption({ label: 'Stomach cover' });
    await rx.getByRole('button', { name: 'Apply' }).click();
    await expect(rx.getByTestId('rx-line-1').getByTestId('rx-remarks')).toHaveText(
      'Take 1 tablet once a day, before breakfast, for 10 days.',
    );
    await expect(rx.getByTestId('rx-save-status')).toHaveText('Saved');

    await rx.getByRole('button', { name: 'Delete template' }).click();
    await expect(rx.getByLabel('Templates')).toHaveCount(0);
  });
});
