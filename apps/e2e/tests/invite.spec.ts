import { expect, pageAlert, setUpFromInvite, test, totp } from '../fixtures';

test.describe('staff invite page', () => {
  test('shows who the invite is for, removes the token from the address bar, and offers Hindi', async ({
    page,
    clinic,
  }) => {
    await page.goto(clinic.inviteLink('front_desk'));
    await expect(page.locator('.summary')).toContainText(
      `You have been invited to ${clinic.name} as Front desk.`,
    );
    await expect(page.locator('.summary')).toContainText('fr****@');
    expect(page.url()).not.toContain('#');

    await page.getByRole('button', { name: 'हिंदी' }).click();
    await expect(page.locator('h1')).toHaveText('अपना स्टाफ़ खाता सेट करें');
  });

  test('checks the password and code, then signs the person straight in', async ({
    page,
    clinic,
  }) => {
    await page.goto(clinic.inviteLink('doctor'));
    await page.getByLabel('Choose a password').fill('short');
    await page.getByLabel('Type the password again').fill('short');
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(pageAlert(page)).toHaveText('Use at least 12 characters.');

    const password = 'a long synthetic passphrase';
    await page.getByLabel('Choose a password').fill(password);
    await page.getByLabel('Type the password again').fill(password);
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.locator('img.qr')).toBeVisible();
    const secret = (await page.getByTestId('manual-key').innerText()).replace(/\s/g, '');
    expect(secret).toHaveLength(32);

    await page.getByLabel('6-digit code from your authenticator app').fill('000000');
    await page.getByRole('button', { name: 'Finish setup' }).click();
    await expect(pageAlert(page)).toHaveText('Enter the 6 digits shown in your authenticator app.');

    await page.getByLabel('6-digit code from your authenticator app').fill(totp(secret));
    await page.getByRole('button', { name: 'Finish setup' }).click();
    await expect(page).toHaveURL(/\/clinic$/);
    await expect(page.getByTestId('signed-in-as')).toContainText('Dr. Synthetic · Doctor');
  });

  test('works only once', async ({ page, clinic, browser }) => {
    const link = clinic.inviteLink('doctor');
    await setUpFromInvite(page, link, 'a long synthetic passphrase');

    const other = await browser.newPage();
    await other.goto(link);
    await expect(pageAlert(other)).toContainText('This invite link is invalid or has expired');
    await other.close();
  });

  test('explains when the link is incomplete', async ({ page }) => {
    await page.goto('/invite');
    await expect(pageAlert(page)).toContainText('This page needs the full invite link');
  });
});
