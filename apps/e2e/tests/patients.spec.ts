import { expect, pageAlert, setUpFromInvite, test } from '../fixtures';

test.describe('patient register', () => {
  test('clinic admin sets UHID numbering and adds the default tags', async ({ page, clinic }) => {
    await setUpFromInvite(page, clinic.inviteLink('clinic_admin'), 'admin synthetic passphrase');
    await expect(page.getByTestId('uhid-preview')).toContainText('10001');

    await page.getByLabel('Prefix (letters or digits, optional)').fill('ek');
    await page.getByLabel('Next number').fill('501');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByTestId('uhid-preview')).toHaveText(
      'The next patient registered gets EK501.',
    );

    await page.getByRole('button', { name: 'Add the default tags' }).click();
    await expect(page.locator('[data-testid^=tag-]')).toHaveCount(6);
    await expect(page.getByTestId('tag-Emergency')).toContainText('Shown first');

    await page.getByTestId('tag-VIP').getByRole('button', { name: 'Archive' }).click();
    await expect(page.getByTestId('tag-VIP')).toContainText('Archived');
  });

  test('front desk registers a walk-in, is warned about a duplicate, and finds them by UHID', async ({
    page,
    clinic,
  }) => {
    await setUpFromInvite(page, clinic.inviteLink('front_desk'), 'desk synthetic passphrase');
    await page.getByRole('link', { name: 'Register patient' }).click();
    await expect(page.getByText('The new UHID will be 10001.')).toBeVisible();

    await page.getByLabel('Name', { exact: true }).fill('Imran Khan');
    await page.getByLabel('Mobile', { exact: true }).fill('98765 43210');
    await page.getByLabel('Date of birth').fill('1985-09-18');
    await page.getByLabel('Gender').selectOption('male');
    await page.getByRole('button', { name: 'Register', exact: true }).click();

    await expect(page.locator('h1')).toHaveText('Imran Khan');
    await expect(page.getByTestId('patient-uhid')).toHaveText('10001');
    await expect(page.getByTestId('patient-meta')).toContainText('+919876543210');
    await expect(page.getByTestId('patient-meta')).toContainText('Male');

    // Registering the same person again shows the existing record first.
    await page.goto('/clinic/patients/new');
    await page.getByLabel('Name', { exact: true }).fill('imran  khan');
    await page.getByLabel('Mobile', { exact: true }).fill('9876543210');
    await page.getByRole('button', { name: 'Register', exact: true }).click();
    const warning = page.getByTestId('duplicates');
    await expect(warning).toContainText('This patient may already be registered');
    await expect(warning).toContainText('10001');
    await warning.getByRole('button', { name: 'Register anyway' }).click();
    await expect(page.getByTestId('patient-uhid')).toHaveText('10002');

    await page.getByRole('link', { name: 'Back to patients' }).click();
    await page.getByPlaceholder('Name, mobile number or UHID').fill('10001');
    await page.getByRole('button', { name: 'Search' }).click();
    await expect(page.locator('table.patients tbody tr')).toHaveCount(1);
    await expect(page.locator('table.patients tbody tr')).toContainText('Imran Khan');
  });

  test('links a child to a guardian, tags patients and edits details', async ({
    page,
    clinic,
    db,
  }) => {
    const org = await db.organisation.findUniqueOrThrow({ where: { slug: clinic.slug } });
    await db.tag.createMany({
      data: [
        { organisationId: org.id, name: 'Priority', colour: '#c2410c', sortToTop: true },
        { organisationId: org.id, name: 'Insurance', colour: '#1d4ed8' },
      ],
    });
    await setUpFromInvite(page, clinic.inviteLink('front_desk'), 'desk synthetic passphrase');

    await page.goto('/clinic/patients/new');
    await page.getByLabel('Name', { exact: true }).fill('Neha Kapoor');
    await page.getByLabel('Mobile', { exact: true }).fill('9123456780');
    await page.getByRole('checkbox', { name: 'Insurance' }).check();
    await page.getByRole('button', { name: 'Register', exact: true }).click();
    await expect(page.getByTestId('patient-tags')).toContainText('Insurance');

    // A child without a phone needs a guardian.
    await page.goto('/clinic/patients/new');
    await page.getByLabel('Name', { exact: true }).fill('Aarav Kapoor');
    await page.getByLabel('Date of birth').fill('2020-05-09');
    await page.getByRole('button', { name: 'Register', exact: true }).click();
    await expect(pageAlert(page)).toContainText('link the patient to a guardian');

    await page.getByLabel('Find guardian').fill('Neha');
    await page.getByLabel('Find guardian').press('Enter');
    await page.getByRole('button', { name: 'Choose' }).click();
    await expect(page.getByTestId('guardian-selected')).toContainText('Neha Kapoor');
    await page.getByRole('button', { name: 'Register', exact: true }).click();

    await expect(page.locator('h1')).toHaveText('Aarav Kapoor');
    await expect(page.getByTestId('family')).toContainText('Neha Kapoor');
    await expect(page.getByTestId('family')).toContainText('Guardian');

    // Tag the child as priority.
    await page.getByRole('checkbox', { name: 'Priority' }).check();
    await page.getByRole('button', { name: 'Save tags' }).click();
    await expect(page.getByTestId('patient-tags')).toContainText('Priority');

    // Edit details.
    await page.getByRole('button', { name: 'Edit details' }).click();
    await page.getByLabel('Address').fill('12 Synthetic Road, Delhi');
    await page.getByLabel('Blood group').selectOption('O+');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('.details')).toContainText('12 Synthetic Road, Delhi');
    await expect(page.locator('.details')).toContainText('O+');

    // The guardian's page lists the child, and the list filters by tag.
    await page.getByTestId('family').getByRole('link', { name: 'Neha Kapoor' }).click();
    await expect(page.getByTestId('family')).toContainText('Aarav Kapoor');
    await expect(page.getByTestId('family')).toContainText('Dependant');

    await page.goto('/clinic');
    await page.getByLabel('Filter by tag').selectOption({ label: 'Priority' });
    await expect(page.locator('table.patients tbody tr')).toHaveCount(1);
    await expect(page.locator('table.patients tbody tr')).toContainText('Aarav Kapoor');
  });
});
