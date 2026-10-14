import { expect, setUpFromInvite, test, totp } from '../fixtures';

const WEB_URL = 'http://localhost:3300';
const DOCTOR_PASSWORD = 'doctor synthetic passphrase';

test.describe('clinic admin: staff devices', () => {
  test('the admin signs one of a doctor’s devices out, then all of them', async ({
    page,
    browser,
    clinic,
  }) => {
    // The doctor signs in on a laptop (through the invite) and then on a second browser.
    const laptop = await (await browser.newContext({ baseURL: WEB_URL })).newPage();
    const secret = await setUpFromInvite(laptop, clinic.inviteLink('doctor'), DOCTOR_PASSWORD);
    const tablet = await (await browser.newContext({ baseURL: WEB_URL })).newPage();
    await tablet.goto('/clinic/login');
    await tablet.getByLabel('Clinic ID').fill(clinic.slug);
    await tablet.getByLabel('Email or mobile number').fill(clinic.email('doctor'));
    await tablet.getByLabel('Password').fill(DOCTOR_PASSWORD);
    await tablet.getByRole('button', { name: 'Sign in' }).click();
    await tablet.getByLabel('Enter the code from your authenticator app').fill(totp(secret, 1));
    await tablet.getByRole('button', { name: 'Verify' }).click();
    await expect(tablet).toHaveURL(/\/clinic$/);

    await setUpFromInvite(page, clinic.inviteLink('clinic_admin'), 'admin synthetic passphrase');
    const row = page.getByTestId(`staff-${clinic.email('doctor')}`);
    await row.getByRole('button', { name: 'Devices' }).click();
    const devices = row.getByRole('group', { name: /^Signed-in devices for/ });
    await expect(devices.getByTestId('device')).toHaveCount(2);
    await expect(devices.getByTestId('device').first()).toContainText('Chrome');

    // One device: the newest sign-in (the tablet) is listed first.
    await devices.getByTestId('device').first().getByRole('button', { name: 'Sign out' }).click();
    await expect(devices.getByRole('status')).toHaveText('Signed out of that device.');
    await expect(devices.getByTestId('device')).toHaveCount(1);

    // Then the rest; the admin's own device row has no sign-out button.
    await devices.getByTestId('device').first().getByRole('button', { name: 'Sign out' }).click();
    await expect(devices).toContainText('Not signed in on any device here.');

    // Both browsers are signed out on their next request.
    for (const signedOut of [laptop, tablet]) {
      await signedOut.goto('/clinic/queue');
      await expect(signedOut).toHaveURL(/\/clinic\/login/);
    }

    // The admin's own devices show "This device" without a sign-out button.
    const own = page.getByTestId(`staff-${clinic.email('clinic_admin')}`);
    await own.getByRole('button', { name: 'Devices' }).click();
    const mine = own.getByRole('group', { name: /^Signed-in devices for/ });
    await expect(mine.getByTestId('device')).toHaveCount(1);
    await expect(mine).toContainText('This device');
    await expect(mine.getByRole('button', { name: 'Sign out' })).toHaveCount(0);

    await page.getByRole('link', { name: 'Audit log' }).click();
    await page.getByLabel('Area').selectOption({ label: 'Staff and invites' });
    await expect(page.getByTestId('audit-entries')).toContainText('staff.session.revoked');
  });
});
