import type { Db } from '@dhc/db';
import { expect, pageAlert, setUpFromInvite, test, type Clinic } from '../fixtures';

const WEB_URL = 'http://localhost:3300';

/** An active doctor and Asha in consultation today. */
async function visitInConsultation(db: Db, clinic: Clinic) {
  const org = await db.organisation.findUniqueOrThrow({ where: { slug: clinic.slug } });
  const doctor = await db.user.findUniqueOrThrow({ where: { email: clinic.email('doctor') } });
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
  const visit = await db.appointment.create({
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
  return visit.id;
}

/**
 * A catalogue row by its test's ID (names can repeat once a test is retired): the clinic's
 * active test of that name, or its only one.
 */
async function itemId(db: Db, clinic: Clinic, name: string) {
  const org = await db.organisation.findUniqueOrThrow({ where: { slug: clinic.slug } });
  const rows = await db.testCatalogueItem.findMany({
    where: { organisationId: org.id, name },
    orderBy: { active: 'desc' },
  });
  return `catalogue-item-${rows[0]!.id}`;
}

test.describe('clinic admin: test catalogue', () => {
  test('the admin adds, edits, reorders and deactivates tests; the doctor orders the new one', async ({
    page,
    browser,
    clinic,
    db,
  }) => {
    test.setTimeout(120_000);
    const visitId = await visitInConsultation(db, clinic);
    await setUpFromInvite(page, clinic.inviteLink('clinic_admin'), 'admin synthetic passphrase');

    await page.getByRole('link', { name: 'Test catalogue' }).click();
    await expect(page).toHaveURL(/\/clinic\/test-catalogue$/);
    const mri = page.getByTestId('catalogue-mri');
    await expect(mri.getByTestId(await itemId(db, clinic, 'MRI'))).toContainText('16 regions');
    const xray = page.getByTestId('catalogue-xray');
    await expect(xray.getByTestId(await itemId(db, clinic, 'X-ray'))).toContainText(
      'Views: AP, PA, Lateral, Oblique, Skyline, Standing',
    );

    // A new MRI with two regions. Only imaging asks for regions; only X-rays for views.
    await page.getByRole('button', { name: 'Add test' }).click();
    const form = page.getByTestId('catalogue-form');
    await form.getByLabel('Type').selectOption('mri');
    await form.getByLabel('Name').fill('  MRI with contrast ');
    await expect(form.getByText('Views doctors can pick')).toHaveCount(0);
    await form.getByLabel('Regions').fill('Knee\nBrain\n');
    await form.getByRole('button', { name: 'Add test' }).click();
    await expect(page.locator('main [role=status]')).toHaveText(
      'MRI with contrast added. Doctors can order it now.',
    );
    const contrast = mri.getByTestId(await itemId(db, clinic, 'MRI with contrast'));
    await expect(contrast).toContainText('2 regions');

    // A second active test of the same name, in any case, is refused.
    await page.getByRole('button', { name: 'Add test' }).click();
    await form.getByLabel('Type').selectOption('blood');
    await form.getByLabel('Name').fill('esr');
    await expect(form.getByLabel('Regions')).toHaveCount(0);
    await form.getByRole('button', { name: 'Add test' }).click();
    await expect(pageAlert(page)).toHaveText('Another active test already has this name.');
    await form.getByRole('button', { name: 'Cancel' }).click();

    // Edit it, then move it above the MRI.
    await contrast.getByRole('button', { name: 'Edit' }).click();
    await expect(form.getByLabel('Type')).toBeDisabled();
    await form.getByLabel('Regions').fill('Knee\nBrain\nShoulder');
    await form.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('main [role=status]')).toHaveText('MRI with contrast saved.');
    await expect(contrast).toContainText('3 regions');
    await contrast.getByRole('button', { name: 'Move MRI with contrast up' }).click();
    await expect(mri.getByRole('listitem').first()).toContainText('MRI with contrast');

    // ECG is switched off: still listed for the admin, gone for the doctor.
    const ecg = page.getByTestId('catalogue-other').getByTestId(await itemId(db, clinic, 'ECG'));
    await ecg.getByRole('button', { name: 'Deactivate' }).click();
    await expect(ecg).toContainText('Inactive');
    await expect(ecg.getByRole('button', { name: 'Reactivate' })).toBeVisible();

    // Survives a reload.
    await page.reload();
    await expect(page.getByTestId('catalogue-mri').getByRole('listitem').first()).toContainText(
      'MRI with contrast',
    );
    await expect(
      page.getByTestId('catalogue-other').getByTestId(await itemId(db, clinic, 'ECG')),
    ).toContainText('Inactive');

    await page.getByRole('link', { name: 'Audit log' }).click();
    await page.getByLabel('Area').selectOption({ label: 'Test catalogue' });
    const entries = page.getByTestId('audit-entries');
    for (const action of [
      'test_catalogue.created',
      'test_catalogue.updated',
      'test_catalogue.reordered',
      'test_catalogue.deactivated',
    ]) {
      await expect(entries).toContainText(action);
    }

    // The doctor, in their own browser, orders the new test; ECG no longer comes up.
    const context = await browser.newContext({ baseURL: WEB_URL });
    const doctor = await context.newPage();
    await setUpFromInvite(doctor, clinic.inviteLink('doctor'), 'doctor synthetic passphrase');
    await expect(doctor.getByRole('link', { name: 'Test catalogue' })).toHaveCount(0);
    await doctor.goto(`/clinic/consultations/${visitId}`);
    const rx = doctor.getByTestId('prescription');
    const tests = rx.getByTestId('tests-section');
    const search = tests.getByRole('textbox', {
      name: 'Add test: search blood tests, X-ray, MRI, CT',
    });
    await search.fill('ecg');
    await expect(tests.getByTestId('tests-matches')).toContainText('No tests match.');
    await search.fill('contrast');
    await tests
      .getByTestId('tests-matches')
      .getByRole('button', { name: 'MRI with contrast', exact: true })
      .click();
    const picker = tests.getByTestId('test-picker');
    await picker.getByLabel('Region').selectOption('Shoulder');
    await picker.getByLabel('Side').selectOption('left');
    await picker.getByRole('button', { name: 'Add test' }).click();
    await expect(tests.getByTestId('test-line-0').getByTestId('test-label')).toHaveText(
      'MRI with contrast shoulder, left',
    );
    await expect(rx.getByTestId('rx-save-status')).toHaveText('Saved');
    await doctor.reload();
    await expect(tests.getByTestId('test-line-0').getByTestId('test-label')).toHaveText(
      'MRI with contrast shoulder, left',
    );
    // The admin then drops the shoulder: the draft still shows it, and still saves.
    await page.goto('/clinic/test-catalogue');
    await page
      .getByTestId('catalogue-mri')
      .getByTestId(await itemId(db, clinic, 'MRI with contrast'))
      .getByRole('button', { name: 'Edit' })
      .click();
    await page.getByTestId('catalogue-form').getByLabel('Regions').fill('Knee\nBrain');
    await page.getByTestId('catalogue-form').getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('main [role=status]')).toHaveText('MRI with contrast saved.');
    await doctor.reload();
    const draftLine = tests.getByTestId('test-line-0');
    await expect(draftLine.getByLabel('Region')).toHaveValue('Shoulder');
    await expect(draftLine.getByLabel('Region').locator('option:checked')).toHaveText(
      'Shoulder (no longer listed)',
    );
    const autosave = doctor.waitForResponse(
      (r) => r.request().method() === 'PUT' && /\/prescription$/.test(r.url()),
    );
    await draftLine.getByLabel('Notes for the lab (printed)').fill('Rule out rotator cuff tear');
    expect((await autosave).status()).toBe(200);
    await expect(rx.getByTestId('rx-save-status')).toHaveText('Saved');
    await doctor.reload();
    await expect(draftLine.getByLabel('Notes for the lab (printed)')).toHaveValue(
      'Rule out rotator cuff tear',
    );

    // The admin then stops offering the test: the draft still shows what it stores, and
    // the doctor can clear the region the test no longer offers.
    await page.reload();
    await page
      .getByTestId('catalogue-mri')
      .getByTestId(await itemId(db, clinic, 'MRI with contrast'))
      .getByRole('button', { name: 'Deactivate' })
      .click();
    await expect(page.locator('main [role=status]')).toContainText(
      'MRI with contrast deactivated.',
    );
    await doctor.reload();
    await expect(draftLine.getByLabel('Region').locator('option:checked')).toHaveText(
      'Shoulder (no longer listed)',
    );
    await expect(draftLine.getByLabel('Side')).toHaveValue('left');
    const cleared = doctor.waitForResponse(
      (r) => r.request().method() === 'PUT' && /\/prescription$/.test(r.url()),
    );
    await draftLine.getByLabel('Region').selectOption('');
    expect((await cleared).status()).toBe(200);
    await expect(draftLine.getByTestId('test-label')).toHaveText('MRI with contrast, left');
    await doctor.reload();
    await expect(draftLine.getByTestId('test-label')).toHaveText('MRI with contrast, left');
    await expect(draftLine.getByLabel('Region')).toHaveCount(0);

    // A doctor cannot open the admin screen.
    await doctor.goto('/clinic/test-catalogue');
    await expect(doctor.getByText('This page is not available for your role.')).toBeVisible();
    await context.close();
  });
});
