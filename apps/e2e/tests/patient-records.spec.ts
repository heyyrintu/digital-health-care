import { expect, signInAsPatient, setUpFromInvite, syntheticMobile, test } from '../fixtures';
import { samplePng } from '../../api/src/modules/branding/logo-samples';
for (const width of [390, 1280])
  test(`patient shares a combined record and a treating doctor retains it (${width}px)`, async ({
    page,
    db,
    clinic,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await setUpFromInvite(page, clinic.inviteLink('doctor'), 'doctor synthetic passphrase');
    const org = await db.organisation.findUniqueOrThrow({ where: { slug: clinic.slug } }),
      doctor = await db.user.findUniqueOrThrow({ where: { email: clinic.email('doctor') } }),
      person = await db.patient.findFirstOrThrow({ where: { organisationId: org.id } }),
      phone = syntheticMobile();
    await db.patient.update({
      where: { id: person.id },
      data: { phone: '+91' + phone, dob: new Date('1992-01-01'), gender: 'female' },
    });
    const place = await db.clinic.create({ data: { organisationId: org.id, name: 'Clinic' } }),
      type = await db.consultationType.create({
        data: {
          organisationId: org.id,
          name: 'Visit',
          mode: 'in_person',
          defaultDurationMin: 15,
          feePaise: 10000,
        },
      }),
      now = new Date();
    const visit = await db.appointment.create({
      data: {
        organisationId: org.id,
        patientId: person.id,
        doctorUserId: doctor.id,
        clinicId: place.id,
        consultationTypeId: type.id,
        date: new Date(new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10)),
        startAt: now,
        endAt: new Date(Date.now() + 900000),
        status: 'in_consultation',
        source: 'app',
        tokenNumber: 1,
        createdByUserId: doctor.id,
      },
    });
    await signInAsPatient(page, db, clinic, phone);
    await page.getByRole('checkbox', { name: 'I have read the privacy notice' }).check();
    await page.getByRole('checkbox', { name: 'I accept the terms of use' }).check();
    await page.getByRole('checkbox', { name: /health records/i }).check();
    await page.getByRole('button', { name: 'Accept and continue' }).click();
    await page
      .getByRole('navigation')
      .getByRole('link', { name: 'My records', exact: true })
      .click();
    await page.getByLabel('Choose files (up to 10)').setInputFiles([
      { name: 'page1.png', mimeType: 'image/png', buffer: samplePng() },
      { name: 'page2.png', mimeType: 'image/png', buffer: samplePng() },
    ]);
    await page.getByLabel('Combine selected photos into one PDF').check();
    await page.getByLabel('Record title').fill('Two-page imaging report');
    await page.getByRole('button', { name: 'Upload records', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Records uploaded.');
    const row = page.getByTestId('patient-upload');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('Two-page imaging report');
    const record = await db.patientRecord.findFirstOrThrow({ where: { patientId: person.id } });
    expect(record.mediaType).toBe('application/pdf');
    await row.getByRole('button', { name: 'Doctor sharing' }).click();
    await row.getByRole('button', { name: 'Create share link' }).click();
    const url = await row.getByLabel('Doctor share link', { exact: true }).inputValue();
    expect(url).toContain('/clinic/record-share#');
    await page.goto(url);
    await expect(page.getByTestId('doctor-patient-record')).toContainText(
      'Two-page imaging report',
    );
    await page.getByRole('button', { name: 'Mark reviewed' }).click();
    await expect(page.getByTestId('doctor-patient-record')).toContainText('Reviewed by');
    await page.goto(`/clinic/consultations/${visit.id}`);
    const care = page.getByTestId('doctor-patient-record');
    await care.getByRole('button', { name: 'Use in this visit' }).click();
    await care.getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(care).toContainText('Used in care');
    expect(await db.patientRecordUse.count({ where: { recordId: record.id } })).toBe(1);
    await page.goto('/app/records');
    await row.getByRole('button', { name: 'Hide from my list' }).click();
    await row.getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(row).toHaveCount(0);
    await page.getByLabel('Show hidden and deleted').check();
    await expect(row).toContainText('Used in care');
    await row.getByRole('button', { name: 'Show again' }).click();
    await expect(row).toHaveCount(0);
    await page.getByLabel('Show hidden and deleted').uncheck();
    await expect(row).toContainText('Two-page imaging report');
    expect(await db.patientRecord.findUnique({ where: { id: record.id } })).toMatchObject({
      state: 'ready',
      hiddenAt: null,
      fileKey: expect.any(String),
    });
  });
test('an interrupted raw upload recovers one record, then requests deletion of the unused file', async ({
  page,
  db,
  clinic,
}) => {
  const org = await db.organisation.findUniqueOrThrow({ where: { slug: clinic.slug } }),
    person = await db.patient.findFirstOrThrow({ where: { organisationId: org.id } }),
    phone = syntheticMobile();
  await db.patient.update({ where: { id: person.id }, data: { phone: '+91' + phone } });
  await signInAsPatient(page, db, clinic, phone);
  await page.getByRole('checkbox', { name: 'I have read the privacy notice' }).check();
  await page.getByRole('checkbox', { name: 'I accept the terms of use' }).check();
  await page.getByRole('checkbox', { name: /health records/i }).check();
  await page.getByRole('button', { name: 'Accept and continue' }).click();
  await page.goto('/app/records');
  let lost = false;
  await page.route('**/portal/records/*/file', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch();
    if (!lost) {
      lost = true;
      await route.abort();
    } else await route.fulfill({ response });
  });
  await page
    .getByLabel('Choose files (up to 10)')
    .setInputFiles({ name: 'report.png', mimeType: 'image/png', buffer: samplePng() });
  await page.getByLabel('Record title').fill('Recovery report');
  await page.getByRole('button', { name: 'Upload records', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry the same batch' })).toBeVisible();
  await page.getByRole('button', { name: 'Retry the same batch' }).click();
  await expect(page.getByRole('status')).toContainText('Records uploaded.');
  expect(await db.patientRecord.count({ where: { patientId: person.id } })).toBe(1);
  const row = page.getByTestId('patient-upload');
  await row.getByRole('button', { name: 'Delete unused record' }).click();
  await row.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(row).toHaveCount(0);
  await page.getByLabel('Show hidden and deleted').check();
  await expect(row).toContainText(/Deletion pending|Deleted/);
});
