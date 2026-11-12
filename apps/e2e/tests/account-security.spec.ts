import { expect, setUpFromInvite, test, totp } from '../fixtures';
const password = 'synthetic security passphrase';
test('staff changes to password-only sign-in after proving the current authenticator', async ({
  page,
  clinic,
}) => {
  const secret = await setUpFromInvite(page, clinic.inviteLink('doctor'), password);
  await page.getByRole('link', { name: 'Your account', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Two-step verification', exact: true }),
  ).toBeVisible();
  await page.getByRole('combobox', { name: 'Verification method' }).selectOption('disabled');
  await page.getByLabel('Your name', { exact: true }).fill('Dr Security');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Saved');
  await expect(page.getByRole('combobox', { name: 'Verification method' })).toHaveValue('disabled');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByLabel(/Current verification code/)).toBeFocused();
  await page.getByLabel(/Current verification code/).fill(totp(secret, 1));
  await page.getByRole('button', { name: 'Save and sign out', exact: true }).click();
  await expect(page).toHaveURL(/\/clinic\/login$/);
  await page.getByLabel('Clinic ID').fill(clinic.slug);
  await page.getByLabel('Email or mobile number').fill(clinic.email('doctor'));
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/clinic$/);
  await expect(page.getByTestId('signed-in-as')).toContainText('Doctor');
});
test('staff and platform password-recovery forms submit request and reset steps', async ({
  page,
}) => {
  for (const audience of ['clinic', 'platform']) {
    await page.goto(`/${audience}/login`);
    await page.getByRole('link', { name: 'Forgot password?', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/${audience}/forgot-password(?:\\?.*)?$`));
    await expect(page.getByRole('button', { name: 'Send reset code', exact: true })).toBeVisible();
    await expect(page.locator('input[type=password]')).toHaveCount(0);
    const namespace = audience === 'clinic' ? 'session' : 'platform-session';
    const context = audience === 'clinic' ? { organisation: 'synthetic-clinic' } : {};
    await page.route(`**/api/${namespace}/password/request`, async (route) => {
      expect(route.request().postDataJSON()).toEqual({
        ...context,
        identifier: 'staff@example.test',
      });
      await route.fulfill({
        status: 202,
        json: {
          challengeId: '11111111-1111-4111-8111-111111111111',
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
        },
      });
    });
    await page.route(`**/api/${namespace}/password/confirm`, async (route) => {
      expect(route.request().postDataJSON()).toEqual({
        ...context,
        challengeId: '11111111-1111-4111-8111-111111111111',
        code: '123456',
        newPassword: password,
      });
      await route.fulfill({ status: 204 });
    });
    if (audience === 'clinic') await page.getByLabel('Clinic ID').fill('synthetic-clinic');
    await page
      .getByLabel(audience === 'clinic' ? 'Email or mobile number' : 'Email', { exact: true })
      .fill('staff@example.test');
    await page.getByRole('button', { name: 'Send reset code', exact: true }).click();
    await expect(page.getByLabel('6-digit code from email', { exact: true })).toBeFocused();
    await page.getByLabel('6-digit code from email', { exact: true }).fill('123456');
    await page.getByLabel('New password (at least 12 characters)', { exact: true }).fill(password);
    await page.getByLabel('Confirm new password', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Reset password', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/${audience}/login\\?password=reset$`));
    await expect(page.getByRole('status')).toContainText('Password reset.');
  }
});

test('platform password-recovery navigation preserves Hindi', async ({ page }) => {
  await page.goto('/platform/login');
  await page.getByRole('button', { name: 'हिंदी', exact: true }).click();
  await page.getByRole('link', { name: 'पासवर्ड भूल गए?', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'पासवर्ड भूल गए?', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'साइन इन पर वापस जाएँ', exact: true }).click();
  await expect(page.getByRole('link', { name: 'पासवर्ड भूल गए?', exact: true })).toBeVisible();
});
