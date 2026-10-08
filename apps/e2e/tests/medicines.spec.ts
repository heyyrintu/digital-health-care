import { randomUUID } from 'node:crypto';
import type { Db } from '@dhc/db';
import { expect, setUpFromInvite, test, type Clinic } from '../fixtures';

/** A prescription with three typed medicines, as if a doctor had written it today. */
async function typedNames(db: Db, clinic: Clinic, names: string[]) {
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
  const startAt = new Date();
  const appointment = await db.appointment.create({
    data: {
      organisationId: org.id,
      patientId: patient.id,
      doctorUserId: doctor.id,
      clinicId: place.id,
      consultationTypeId: type.id,
      date: new Date(`${new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10)}T00:00:00Z`),
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
  await db.prescription.create({
    data: {
      organisationId: org.id,
      appointmentId: appointment.id,
      patientId: patient.id,
      doctorUserId: doctor.id,
      items: {
        create: names.map((name, sortOrder) => ({
          id: randomUUID(),
          organisationId: org.id,
          name,
          steps: [],
          remarks: '',
          sortOrder,
        })),
      },
    },
  });
}

test.describe('medicine list', () => {
  test('the clinic admin clears the approval queue and keeps the clinic’s own medicines', async ({
    page,
    clinic,
    db,
  }) => {
    await setUpFromInvite(page, clinic.inviteLink('clinic_admin'), 'admin synthetic passphrase');
    await typedNames(db, clinic, ['Zerodol SP', 'crocin', 'Knee cap support']);
    await page.getByRole('link', { name: 'Medicines' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Medicines' })).toBeVisible();

    // Link a brand name to the listed medicine it means.
    const crocin = page.getByTestId('pending-crocin');
    await expect(crocin).toContainText('Prescriptions: 1 · Doctors: 1');
    await crocin.getByRole('button', { name: 'Same as a listed medicine' }).click();
    await crocin.getByLabel('Which listed medicine is “crocin”?').fill('Paracetamol 5');
    await crocin.getByRole('button', { name: /^Link to Paracetamol 500/ }).click();
    await expect(page.getByRole('status')).toHaveText(
      'Doctors searching “crocin” now find Paracetamol 500.',
    );
    await expect(page.getByTestId('decided-crocin')).toContainText('Approved: Paracetamol 500');

    // Add a typed name as a new medicine, with its molecule for the safety checks.
    const zerodol = page.getByTestId('pending-zerodol sp');
    await zerodol.getByRole('button', { name: 'Add as new medicine' }).click();
    const form = zerodol.getByRole('form', { name: 'New medicine' });
    await expect(form.getByLabel('Brand name')).toHaveValue('Zerodol SP');
    await form.getByLabel('Generic name').fill('Aceclofenac + Paracetamol + Serratiopeptidase');
    await form.getByLabel('Composition').fill('Aceclofenac 100 mg + Paracetamol 325 mg');
    await form.getByLabel('Form', { exact: true }).fill('tablet');
    await form.getByLabel('Find a molecule').fill('acecl');
    await form.getByRole('button', { name: 'Add Aceclofenac' }).click();
    const ingredient = form.getByTestId('ingredient-Aceclofenac');
    await ingredient.getByLabel('Strength is').selectOption('unit');
    await ingredient.getByLabel('mg', { exact: true }).fill('100');
    await form.getByRole('button', { name: 'Add as new medicine' }).click();
    await expect(page.getByRole('status')).toHaveText(
      'Doctors searching “Zerodol SP” now find Zerodol SP.',
    );

    // Reject a name that is not a medicine, then undo it.
    const knee = page.getByTestId('pending-knee cap support');
    await knee.getByRole('button', { name: 'Reject' }).click();
    await knee.getByLabel('Why reject “Knee cap support”?').fill('An appliance, not a medicine');
    await knee.getByRole('button', { name: 'Reject name' }).click();
    await expect(page.getByText('Nothing waiting. Every typed name has a decision.')).toBeVisible();
    const decided = page.getByTestId('decided-knee cap support');
    await expect(decided).toContainText('Rejected');
    await expect(decided).toContainText('An appliance, not a medicine');
    await decided.getByRole('button', { name: 'Undo' }).click();
    await expect(page.getByRole('status')).toHaveText('“Knee cap support” is back in the queue.');
    await expect(page.getByTestId('pending-knee cap support')).toBeVisible();

    // The clinic's own medicine in the list: searchable, editable, deactivated and back.
    await page.getByRole('tab', { name: 'Medicine list' }).click();
    await page.getByLabel('Source').selectOption('clinic');
    const row = page.getByTestId('medicine-Zerodol SP');
    await expect(row).toContainText('Added by this clinic');
    await expect(row).not.toContainText('No ingredients');
    await row.getByRole('button', { name: 'Deactivate' }).click();
    await expect(row).toBeHidden();
    await page.getByLabel('Show inactive').check();
    await expect(row).toContainText('Inactive');
    await row.getByRole('button', { name: 'Reactivate' }).click();
    await expect(row).not.toContainText('Inactive');

    await row.getByRole('button', { name: 'Edit' }).click();
    const edit = page.getByRole('form', { name: 'Edit Zerodol SP' });
    await expect(
      edit.getByTestId('ingredient-Aceclofenac').getByLabel('mg', { exact: true }),
    ).toHaveValue('100');
    await edit.getByLabel('Form', { exact: true }).fill('film-coated tablet');
    await edit.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('status')).toHaveText('Saved Zerodol SP.');
    await expect(row).toContainText('film-coated tablet');

    // Reference medicines are read-only here.
    await page.getByLabel('Source').selectOption('reference');
    await page.getByLabel('Search medicines').fill('Paracetamol 500');
    const reference = page.getByTestId('medicine-Paracetamol 500');
    await expect(reference).toContainText('Reference list');
    await expect(reference.getByRole('button')).toHaveCount(0);
  });

  test('only the clinic admin can open the medicine list', async ({ page, clinic }) => {
    await setUpFromInvite(page, clinic.inviteLink('doctor'), 'doctor synthetic passphrase');
    await page.goto('/clinic/medicines');
    await expect(page.getByText('This page is not available for your role.')).toBeVisible();
  });
});
