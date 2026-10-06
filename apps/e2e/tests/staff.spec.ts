import { randomInt } from 'node:crypto';
import { expect, pageAlert, setUpFromInvite, test } from '../fixtures';

/** A fresh synthetic mobile per run: people (unlike clinics) are shared across tests. */
const syntheticMobile = () => `9${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;

test.describe('clinic admin: staff', () => {
  test('invites staff from the dashboard, revokes an invite, and the invitee joins', async ({
    page,
    clinic,
    browser,
  }) => {
    await setUpFromInvite(page, clinic.inviteLink('clinic_admin'), 'admin synthetic passphrase');
    await expect(page.locator('[data-testid^=staff-]')).toHaveCount(1);
    await expect(page.locator('[data-testid^=pending-]')).toHaveCount(2);

    const mobile = syntheticMobile();
    await page.getByLabel('Email or mobile number').fill(mobile);
    await page.getByLabel('Name (optional)').fill('Synthetic Receptionist');
    await page.getByLabel('Role').selectOption('front_desk');
    await page.getByRole('button', { name: 'Create invite link' }).click();
    const inviteLink = await page.getByTestId('invite-link').innerText();
    await expect(page.getByTestId(`pending-+91${mobile}`)).toContainText('Front desk');
    await expect(page.getByLabel('Email or mobile number')).toHaveValue('');

    // Revoking the seeded front-desk invite kills its link.
    await page
      .getByTestId(`pending-${clinic.email('front_desk')}`)
      .getByRole('button', { name: 'Revoke' })
      .click();
    await expect(page.getByTestId(`pending-${clinic.email('front_desk')}`)).toHaveCount(0);
    const probe = await browser.newPage();
    await probe.goto(clinic.inviteLink('front_desk'));
    await expect(pageAlert(probe)).toContainText('invalid or has expired');
    await probe.close();

    // The new receptionist joins and moves from pending to the team.
    const receptionist = await (await browser.newContext()).newPage();
    await setUpFromInvite(receptionist, inviteLink, 'receptionist synthetic passphrase');
    await expect(receptionist.getByTestId('signed-in-as')).toContainText('Front desk');

    await page.reload();
    await expect(page.getByTestId(`staff-+91${mobile}`)).toContainText('Sign-in set up');
    await expect(page.getByTestId(`pending-+91${mobile}`)).toHaveCount(0);
  });

  test('shows invite form errors next to the form', async ({ page, clinic }) => {
    await setUpFromInvite(page, clinic.inviteLink('clinic_admin'), 'admin synthetic passphrase');

    await page.getByLabel('Email or mobile number').fill('not-an-address');
    await page.getByRole('button', { name: 'Create invite link' }).click();
    await expect(page.locator('#invite-error')).toHaveText(
      'Enter an email address or Indian mobile number.',
    );

    await page.getByLabel('Email or mobile number').fill(clinic.email('clinic_admin'));
    await page.getByLabel('Role').selectOption('clinic_admin');
    await page.getByRole('button', { name: 'Create invite link' }).click();
    await expect(page.locator('#invite-error')).toHaveText('This person already has that role.');
  });

  test('resets a doctor’s sign-in: their session ends and they set up again', async ({
    page: admin,
    clinic,
    browser,
  }) => {
    await setUpFromInvite(admin, clinic.inviteLink('clinic_admin'), 'admin synthetic passphrase');
    const doctor = await (await browser.newContext()).newPage();
    const oldSecret = await setUpFromInvite(
      doctor,
      clinic.inviteLink('doctor'),
      'doctor old passphrase',
    );

    await admin.reload();
    await expect(
      admin.getByTestId(`staff-${clinic.email('clinic_admin')}`).getByRole('button'),
    ).toHaveCount(0);
    const row = admin.getByTestId(`staff-${clinic.email('doctor')}`);
    await row.getByRole('button', { name: 'Reset sign-in' }).click();
    await expect(row.locator('.confirm')).toContainText('signs Dr. Synthetic out everywhere');
    await row.getByRole('button', { name: 'Yes, reset' }).click();
    const resetLink = await row.getByTestId('reset-link').innerText();
    await expect(row).toContainText('Sign-in not set up');

    // The doctor's open dashboard is signed out on its next request.
    await doctor.getByRole('button', { name: 'Search' }).click();
    await expect(doctor).toHaveURL(/\/clinic\/login$/);
    await expect(doctor.locator('main [role=status]')).toHaveText(
      'Your session has ended. Please sign in again.',
    );

    await doctor.goto(resetLink);
    await expect(doctor.locator('h1')).toHaveText('Reset your sign-in');
    const newSecret = await setUpFromInvite(doctor, resetLink, 'doctor new passphrase', 1);
    expect(newSecret).not.toBe(oldSecret);

    await admin.reload();
    await expect(admin.getByTestId(`staff-${clinic.email('doctor')}`)).toContainText(
      'Sign-in set up',
    );
  });
});
