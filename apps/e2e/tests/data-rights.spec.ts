import { createHmac, hkdfSync } from 'node:crypto';
import { expect, signInAsPatient, setUpFromInvite, syntheticMobile, test } from '../fixtures';
import { E2E_JWT_SECRET } from '../env';
for (const width of [390, 1280])
  test(`patient data rights work after consent withdrawal, reviewed correction, download and closure (${width}px)`, async ({
    page,
    db,
    clinic,
    browser,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const org = await db.organisation.findUniqueOrThrow({ where: { slug: clinic.slug } }),
      p = await db.patient.findFirstOrThrow({ where: { organisationId: org.id } }),
      phone = syntheticMobile();
    await db.patient.update({
      where: { id: p.id },
      data: { name: 'Rights Patient', phone: '+91' + phone, dob: new Date('1990-01-01') },
    });
    await signInAsPatient(page, db, clinic, phone);
    await page.getByRole('checkbox', { name: 'I have read the privacy notice' }).check();
    await page.getByRole('checkbox', { name: 'I accept the terms of use' }).check();
    await page.getByRole('checkbox', { name: /health records/i }).check();
    await page.getByRole('button', { name: 'Accept and continue' }).click();
    await expect(page.getByRole('navigation')).toBeVisible();
    await db.accountConsent.updateMany({
      where: { organisationId: org.id, kind: 'health_data' },
      data: { withdrawnAt: new Date() },
    });
    await page.goto('/app/data-rights');
    await expect(
      page.getByRole('heading', { name: 'Your data and account', exact: true }),
    ).toBeVisible();
    await page.getByLabel('Corrected value', { exact: true }).fill('Corrected Rights Patient');
    await page
      .getByLabel('Explain what needs to change', { exact: true })
      .fill('Please correct my name');
    await page.getByRole('button', { name: 'Submit request', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText(
      'Request submitted. Track its response below.',
    );
    const context = await browser.newContext(),
      staff = await context.newPage();
    await setUpFromInvite(staff, clinic.inviteLink('clinic_admin'), 'admin synthetic passphrase');
    await staff.goto('/clinic/data-rights');
    const card = staff.locator('article').filter({ hasText: 'Please correct my name' });
    await expect(card).toBeVisible();
    await card.getByRole('combobox', { name: 'Status', exact: true }).selectOption('fulfilled');
    await card.getByLabel('Response to patient', { exact: true }).fill('Name corrected.');
    await card.getByRole('button', { name: 'Save decision' }).click();
    await expect(card).toContainText('Completed');
    await context.close();
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(
      page.locator('article').filter({ hasText: 'Please correct my name' }),
    ).toContainText('Name corrected.');
    const dl = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download my data', exact: true }).click();
    const download = await dl;
    expect(download.suggestedFilename()).toMatch(/^patient-data-.*\.zip$/);
    await expect(page.getByRole('status')).toHaveText(
      'Download prepared. Keep it somewhere private.',
    );
    await page
      .getByRole('checkbox', {
        name: 'I understand and want to close this clinic’s patient account.',
      })
      .check();
    await page.getByRole('button', { name: 'Send closure code' }).click();
    await expect(page.getByLabel('Closure code', { exact: true })).toBeVisible();
    const challenge = await db.otpChallenge.findFirstOrThrow({
        where: { organisationId: org.id, phone: '+91' + phone, purpose: 'account_close' },
        orderBy: { createdAt: 'desc' },
      }),
      code = '654321';
    const hash = createHmac(
      'sha256',
      Buffer.from(hkdfSync('sha256', E2E_JWT_SECRET, 'dhc-otp', 'otp-code-hash', 32)),
    )
      .update(`${challenge.id}:${code}`)
      .digest('base64url');
    await db.otpChallenge.update({ where: { id: challenge.id }, data: { codeHash: hash } });
    await page.getByLabel('Closure code', { exact: true }).fill(code);
    await page.getByRole('button', { name: 'Close patient account', exact: true }).click();
    await expect(page.getByRole('status')).toContainText(
      'Your patient account at this clinic is closed.',
    );
    expect(
      (await db.patient.findUniqueOrThrow({ where: { id: p.id } })).portalClosedAt,
    ).not.toBeNull();
    await expect(page.getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
  });
