import { expect, setUpFromInvite, test, totp } from '../fixtures';
for (const width of [390, 1280]) {
  test(`People directory, profiles, roles and access (${width}px)`, async ({
    page,
    clinic,
    browser,
    db,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    await setUpFromInvite(page, clinic.inviteLink('clinic_admin'), 'admin synthetic passphrase');
    const doctor = await (await browser.newContext()).newPage();
    await setUpFromInvite(doctor, clinic.inviteLink('doctor'), 'doctor synthetic passphrase');
    await page.goto('/clinic/staff');
    await page.getByLabel('Search by name, email or mobile').fill('Dr. Synthetic');
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await page.getByRole('link', { name: 'Dr. Synthetic', exact: true }).click();
    await page.getByRole('textbox', { name: 'Display name', exact: true }).fill('Dr. Updated');
    await page.getByRole('button', { name: 'Save profile', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Dr. Updated', exact: true })).toBeVisible();
    await page.getByRole('tab', { name: 'Roles', exact: true }).click();
    await page.getByRole('checkbox', { name: 'Front desk', exact: true }).check();
    await page.getByRole('button', { name: 'Save roles', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('Changes saved.');
    await doctor.goto('/clinic/queue');
    await expect(doctor).toHaveURL(/\/clinic\/login/);
    await page.screenshot({ path: testInfo.outputPath(`people-${width}.png`), fullPage: true });
    await page.getByRole('tab', { name: 'Access', exact: true }).click();
    await page.getByRole('button', { name: 'Disable clinic access', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm disable access', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Enable clinic access', exact: true }),
    ).toBeVisible();
    await page.getByRole('tab', { name: 'Roles', exact: true }).click();
    await expect(page.getByRole('checkbox', { name: 'Clinic admin', exact: true })).toBeDisabled();
    await page.getByRole('tab', { name: 'Access', exact: true }).click();
    await page.getByRole('button', { name: 'Enable clinic access', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Disable clinic access', exact: true }),
    ).toBeVisible();
    const user = await db.user.findUniqueOrThrow({ where: { email: clinic.email('doctor') } });
    expect(await db.membership.count({ where: { userId: user.id, status: 'active' } })).toBe(2);
    await page.getByRole('tab', { name: 'Activity', exact: true }).click();
    await expect(page.getByText('Staff profile or clinic access updated').first()).toBeVisible();
    await page.goto('/clinic/staff');
    await page.getByRole('link', { name: 'Clinic Admin', exact: true }).click();
    await page.getByRole('tab', { name: 'Roles', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Save roles', exact: true })).toBeDisabled();
    await page.getByRole('tab', { name: 'Access', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Disable clinic access', exact: true }),
    ).toBeDisabled();
    await page.goto('/clinic/account');
    await expect(page.getByRole('heading', { name: 'Your account', exact: true })).toBeVisible();
    await expect(page.getByText('No pending or recent changes.', { exact: true })).toBeVisible();
    await doctor.context().close();
  });
}

for (const width of [390, 1280]) {
  test(`Staff owner verifies their new email and signs in again (${width}px)`, async ({
    page,
    clinic,
    browser,
    db,
  }, testInfo) => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const { fileURLToPath } = await import('node:url');
    const { E2E_FIELD_ENCRYPTION_KEY, E2E_JWT_SECRET } = await import('../env');
    await setUpFromInvite(page, clinic.inviteLink('clinic_admin'), 'admin synthetic passphrase');
    const staff = await (await browser.newContext()).newPage();
    await staff.setViewportSize({ width, height: 1000 });
    const secret = await setUpFromInvite(
      staff,
      clinic.inviteLink('doctor'),
      'doctor synthetic passphrase',
    );
    const seeded = await promisify(execFile)(
      'pnpm',
      ['exec', 'tsx', 'test/seed-staff-contact.ts'],
      {
        cwd: fileURLToPath(new URL('../../api', import.meta.url)),
        env: {
          ...process.env,
          E2E_CONTACT_CLINIC: clinic.slug,
          E2E_JWT_SECRET,
          E2E_FIELD_ENCRYPTION_KEY,
        },
      },
    );
    const pending = JSON.parse(seeded.stdout) as { code: string; destination: string };
    await staff.goto('/clinic/account');
    await expect(staff.getByText(pending.destination, { exact: false })).toBeVisible();
    await staff.getByLabel('Verification code', { exact: true }).fill(pending.code);
    await staff
      .getByLabel('Your current password', { exact: true })
      .fill('doctor synthetic passphrase');
    await staff.screenshot({
      path: testInfo.outputPath(`verify-email-${width}.png`),
      fullPage: true,
    });
    await staff.getByRole('button', { name: 'Verify and update sign-in', exact: true }).click();
    await expect(staff).toHaveURL(/\/clinic\/login\?account=updated/);
    await expect(staff.getByRole('status')).toContainText('Your sign-in detail was updated.');
    await staff.getByLabel('Clinic ID', { exact: true }).fill(clinic.slug);
    await staff.getByLabel('Email or mobile number', { exact: true }).fill(pending.destination);
    await staff.getByLabel('Password', { exact: true }).fill('doctor synthetic passphrase');
    await staff.getByRole('button', { name: 'Sign in', exact: true }).click();
    await staff
      .getByLabel('Enter the code from your authenticator app', { exact: true })
      .fill(totp(secret, 1));
    await staff.getByRole('button', { name: 'Verify', exact: true }).click();
    await expect(staff).toHaveURL(/\/clinic$/);
    expect(
      (await db.user.findUniqueOrThrow({ where: { email: pending.destination } })).displayName,
    ).toBe('Dr. Synthetic');
    await staff.context().close();
  });
}
