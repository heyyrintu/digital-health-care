import { expect, setUpFromInvite, syntheticMobile, test } from '../fixtures';
for (const width of [390, 1280]) {
  test(`Admin CSV import preview, apply recovery and reupload (${width}px)`, async ({
    page,
    db,
    clinic,
  }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    await setUpFromInvite(page, clinic.inviteLink('clinic_admin'), 'synthetic admin passphrase');
    const org = await db.organisation.findUniqueOrThrow({ where: { slug: clinic.slug } });
    await page.goto('/clinic/imports');
    await page
      .getByLabel('Source system label (lowercase letters, digits, - or _)', { exact: true })
      .fill('legacy');
    const phone = syntheticMobile(),
      name = 'Synthetic Imported Patient',
      csv = `externalId,name,phone,dob,gender,email,address,uhid\nOLD-1,${name},${phone},1990-02-03,female,synthetic@example.test,"Synthetic street, city",LEGACY001`;
    await page
      .getByLabel('Patient CSV file', { exact: true })
      .setInputFiles({ name: 'synthetic.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
    await page.getByRole('button', { name: 'Run dry-run preview', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Preview only');
    await expect(page.getByText(name, { exact: false })).toBeVisible();
    expect(await db.patient.count({ where: { organisationId: org.id, name } })).toBe(0);
    await expect(
      page.getByRole('button', { name: 'Confirm patient import', exact: true }),
    ).toBeDisabled();
    await page.getByRole('checkbox', { name: /I checked every row/ }).check();
    let interrupted = false;
    await page.route('**/patient-imports/*/apply', async (route) => {
      const response = await route.fetch();
      if (!interrupted && response.status() === 200) {
        interrupted = true;
        await route.abort('failed');
      } else await route.fulfill({ response });
    });
    await page.getByRole('button', { name: 'Confirm patient import', exact: true }).click();
    await expect(page.locator('main [role=alert]')).toBeVisible();
    expect(interrupted).toBe(true);
    await page.getByRole('button', { name: 'Confirm patient import', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Import completed');
    expect(await db.patient.count({ where: { organisationId: org.id, name } })).toBe(1);
    await page.screenshot({ path: info.outputPath(`patient-import-${width}.png`), fullPage: true });
    await page.getByRole('button', { name: 'Run dry-run preview', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('1 Already imported');
    await page.getByRole('checkbox', { name: /I checked every row/ }).check();
    await page.getByRole('button', { name: 'Confirm patient import', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Import completed');
    expect(await db.patientImportRecord.count({ where: { organisationId: org.id } })).toBe(1);
    await page.getByLabel('Patient CSV file', { exact: true }).setInputFiles({
      name: 'invalid.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('id,id\n1,2'),
    });
    await expect(page.locator('main [role=alert]')).toContainText('unique');
    await expect(
      page.getByRole('button', { name: 'Run dry-run preview', exact: true }),
    ).toBeDisabled();
  });
}
