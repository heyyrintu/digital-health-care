import { expect, setUpFromInvite, signInAsPatient, syntheticMobile, test } from '../fixtures';
for (const width of [390, 1280]) {
  test(`Assessment builder, patient response and doctor score history (${width}px)`, async ({
    page,
    db,
    clinic,
    browser,
  }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    await setUpFromInvite(page, clinic.inviteLink('doctor'), 'synthetic doctor passphrase');
    const org = await db.organisation.findUniqueOrThrow({ where: { slug: clinic.slug } });
    const patient = await db.patient.findFirstOrThrow({
        where: { organisationId: org.id, name: 'Asha Verma' },
      }),
      phone = syntheticMobile();
    await db.patient.update({
      where: { id: patient.id },
      data: { phone: '+91' + phone, dob: new Date('1992-03-14'), gender: 'female' },
    });
    await page.goto('/clinic/assessments');
    await page.getByLabel('Title (English)', { exact: true }).fill('Synthetic daily questionnaire');
    await page.getByLabel('Question (English)', { exact: true }).fill('Synthetic rating');
    await page.getByRole('button', { name: 'Publish form', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('Form published.');
    await page.goto(`/clinic/patients/${patient.id}/assessments`);
    await page
      .getByRole('combobox', { name: 'Assessment form', exact: true })
      .selectOption({ label: 'Synthetic daily questionnaire' });
    await page.getByRole('button', { name: 'Assign assessment', exact: true }).click();
    await expect(page.getByText(/Awaiting answers/)).toBeVisible();
    const context = await browser.newContext({ viewport: { width, height: 1000 } }),
      portal = await context.newPage();
    await signInAsPatient(portal, db, clinic, phone);
    await portal.getByRole('checkbox', { name: 'I have read the privacy notice' }).check();
    await portal.getByRole('checkbox', { name: 'I accept the terms of use' }).check();
    await portal.getByRole('checkbox', { name: /health records/i }).check();
    await portal.getByRole('button', { name: 'Accept and continue' }).click();
    await portal.goto('/app/assessments');
    await portal.getByRole('combobox', { name: 'Synthetic rating', exact: true }).selectOption('7');
    await portal.getByRole('button', { name: 'Submit answers', exact: true }).click();
    await expect(portal.getByText('Raw score: 7 (0–10)', { exact: true })).toBeVisible();
    await expect(portal.getByRole('button', { name: 'Submit answers', exact: true })).toHaveCount(
      0,
    );
    await portal.screenshot({
      path: info.outputPath(`assessment-patient-${width}.png`),
      fullPage: true,
    });
    await page.getByRole('button', { name: 'Reload latest assessments', exact: true }).click();
    await expect(page.getByText('Raw score: 7 (0–10)', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Assign assessment', exact: true }).click();
    await expect(page.getByText(/Awaiting answers/)).toBeVisible();
    await portal.reload();
    await portal.getByRole('combobox', { name: 'Synthetic rating', exact: true }).selectOption('4');
    await portal.getByRole('button', { name: 'Submit answers', exact: true }).click();
    await expect(portal.getByText('Raw score: 4 (0–10)', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Reload latest assessments', exact: true }).click();
    await expect(page.getByText('Raw score: 4 (0–10)', { exact: true })).toBeVisible();
    await page
      .getByRole('combobox', { name: 'Filter by published form', exact: true })
      .selectOption({ index: 1 });
    await expect(
      page.getByRole('img', { name: 'History and score trend', exact: true }),
    ).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: info.outputPath(`assessment-history-${width}.png`),
      fullPage: true,
    });
    expect(
      await db.patientAssessment.count({ where: { patientId: patient.id, state: 'submitted' } }),
    ).toBe(2);
    await context.close();
  });
}
