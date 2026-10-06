import { expect, pageAlert, setUpFromInvite, test, totp } from '../fixtures';

const PASSWORD = 'doctor synthetic passphrase';

test.describe('staff web sign-in', () => {
  test('keeps the session in a cookie page scripts cannot read, across reloads', async ({
    page,
    clinic,
    context,
  }) => {
    await setUpFromInvite(page, clinic.inviteLink('doctor'), PASSWORD);
    await expect(page.locator('table.patients tbody tr')).toHaveCount(3);

    const cookie = (await context.cookies()).find((c) => c.name === 'dhc_session');
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/api/session' });
    expect(await page.evaluate(() => document.cookie)).not.toContain('dhc_session');

    await page.reload();
    await expect(page.getByTestId('signed-in-as')).toBeVisible();

    await page.getByPlaceholder('Name, mobile number or UHID').fill('asha');
    await page.getByRole('button', { name: 'Search' }).click();
    await expect(page.locator('table.patients tbody tr')).toHaveCount(1);
    await expect(page.locator('table.patients tbody tr')).toContainText('Asha Verma');
  });

  test('signs out, clears the cookie, and protects the dashboard', async ({
    page,
    clinic,
    context,
  }) => {
    await setUpFromInvite(page, clinic.inviteLink('doctor'), PASSWORD);
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/clinic\/login$/);
    expect((await context.cookies()).some((c) => c.name === 'dhc_session')).toBe(false);

    await page.goto('/clinic');
    await expect(page).toHaveURL(/\/clinic\/login$/);
  });

  test('signs in with password and authenticator code', async ({ page, clinic }) => {
    const secret = await setUpFromInvite(page, clinic.inviteLink('doctor'), PASSWORD);
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/clinic\/login$/);

    await page.getByLabel('Clinic ID').fill(clinic.slug);
    await page.getByLabel('Email or mobile number').fill(clinic.email('doctor'));
    await page.getByLabel('Password').fill('not the right password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(pageAlert(page)).toHaveText('Invalid sign-in details.');

    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    // The setup step already used this period's code; codes work once.
    await page.getByLabel('Enter the code from your authenticator app').fill(totp(secret, 1));
    await page.getByRole('button', { name: 'Verify' }).click();
    await expect(page).toHaveURL(/\/clinic$/);
    await expect(page.getByTestId('signed-in-as')).toContainText('Doctor');
  });

  test('signs out after 15 minutes without activity', async ({ page, clinic }) => {
    await page.clock.install();
    await setUpFromInvite(page, clinic.inviteLink('doctor'), PASSWORD);

    await page.clock.fastForward('14:00');
    await expect(page.getByTestId('signed-in-as')).toBeVisible();

    await page.clock.fastForward('01:30');
    await expect(page).toHaveURL(/\/clinic\/login$/);
    await expect(page.locator('main [role=status]')).toHaveText(
      'You were signed out after 15 minutes without activity.',
    );
  });
});
