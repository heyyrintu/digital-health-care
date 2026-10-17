import type { Db } from '@dhc/db';
import { randomBytes } from 'node:crypto';
import {
  OPERATOR_PASSWORD,
  expect,
  pageAlert,
  signInToConsole,
  test,
  totp,
  type Clinic,
} from '../fixtures';

const WRONG_PASSWORD = 'not the operator passphrase';
const WRONG_CODE = '000000';
const TICKET = 'SUP-1234';

/** The clinic's doctor as an active doctor with a filled-in prescription pad, waiting for verification. */
async function pendingDoctor(db: Db, clinic: Clinic) {
  const org = await db.organisation.findUniqueOrThrow({ where: { slug: clinic.slug } });
  const user = await db.user.findFirstOrThrow({ where: { email: clinic.email('doctor') } });
  await db.membership.updateMany({
    where: { organisationId: org.id, userId: user.id, role: 'doctor' },
    data: { status: 'active' },
  });
  // Long ago (the morning of 1 Jan 2020 in IST), so it sorts onto the first page of the queue (oldest first) whatever else is waiting.
  const submittedAt = new Date(Date.UTC(2020, 0, 1) + Math.floor(Math.random() * 43_200_000));
  return db.doctorProfile.create({
    data: {
      organisationId: org.id,
      userId: user.id,
      registrationNumber: `TEST-${randomBytes(3).toString('hex')}`,
      council: 'Test Medical Council',
      qualifications: 'MBBS, MD (Medicine)',
      submittedAt,
    },
  });
}

test.describe('platform console', () => {
  test('signs in with password and authenticator, in a session of its own', async ({
    page,
    context,
    operator,
  }) => {
    await page.goto('/platform');
    await expect(page).toHaveURL(/\/platform\/login$/);
    await expect(page.locator('meta[name=robots]')).toHaveAttribute('content', 'noindex, nofollow');

    await page.getByLabel('Work email').fill(operator.email);
    await page.getByLabel('Password').fill(WRONG_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(pageAlert(page)).toHaveText('Email or password not recognised.');

    await page.getByLabel('Password').fill(OPERATOR_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    const code = page.getByLabel('Enter the code from your authenticator app');
    await code.fill(WRONG_CODE);
    await page.getByRole('button', { name: 'Verify' }).click();
    await expect(pageAlert(page)).toHaveText(
      'That code is not right or has expired. Enter the current code from your authenticator app.',
    );
    await code.fill(totp(operator.totpKey));
    await page.getByRole('button', { name: 'Verify' }).click();
    await expect(page).toHaveURL(/\/platform$/);
    await expect(page.getByTestId('signed-in-as')).toHaveText(
      `Signed in as ${operator.name} (${operator.email})`,
    );
    await expect(page.locator('meta[name=robots]')).toHaveAttribute('content', 'noindex, nofollow');

    // Its own httpOnly cookie on its own routes; no clinic session, and the clinic does not let it in.
    const cookies = await context.cookies();
    expect(cookies.find((c) => c.name === 'dhc_platform_session')).toMatchObject({
      httpOnly: true,
      sameSite: 'Strict',
      path: '/api/platform-session',
    });
    expect(cookies.some((c) => c.name === 'dhc_session')).toBe(false);
    expect(await page.evaluate(() => document.cookie)).not.toContain('dhc_platform_session');
    await page.goto('/clinic');
    await expect(page).toHaveURL(/\/clinic\/login$/);

    // Reloads keep the console session (the refresh token rotates through the cookie).
    await page.goto('/platform/usage');
    await expect(page.getByTestId('signed-in-as')).toContainText(operator.email);

    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/platform\/login$/);
    // The page signs out at once; the logout request clearing the cookie may still be on its way.
    await expect
      .poll(async () => (await context.cookies()).some((c) => c.name === 'dhc_platform_session'))
      .toBe(false);
    await page.goto('/platform');
    await expect(page).toHaveURL(/\/platform\/login$/);
  });

  test('locks sign-in for 15 minutes after five wrong passwords', async ({ page, operator }) => {
    await page.goto('/platform/login');
    await page.getByLabel('Work email').fill(operator.email);
    for (let i = 0; i < 5; i++) {
      await page.getByLabel('Password').fill(WRONG_PASSWORD);
      await page.getByRole('button', { name: 'Sign in' }).click();
      await expect(pageAlert(page)).toHaveText('Email or password not recognised.');
    }
    await page.getByLabel('Password').fill(OPERATOR_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(pageAlert(page)).toHaveText(
      'Too many attempts. Sign-in is locked for 15 minutes.',
    );
  });

  test('onboards an organisation and shows the admin’s invite link once', async ({
    page,
    context,
    operator,
    browser,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await signInToConsole(page, operator);
    const slug = `e2e-onb-${randomBytes(3).toString('hex')}`;
    const form = page.getByRole('form', { name: 'Onboard organisation' });

    await form.getByLabel('Organisation name').fill('Sunrise Synthetic Clinics');
    await form.getByLabel('Organisation ID').fill(slug);
    await form.getByLabel('First clinic’s name').fill('Sunrise Main');
    await form.getByLabel('First clinic admin’s email or mobile number').fill(`admin@${slug}.test`);
    await form.getByLabel('First clinic admin’s name').fill('Synthetic Admin');
    await form.getByRole('button', { name: 'Onboard organisation' }).click();

    const handover = page.getByTestId('onboard-handover');
    await expect(handover).toContainText(
      'Sunrise Synthetic Clinics is set up. Give this invite link to Synthetic Admin directly:',
    );
    await expect(handover).toContainText('This link is shown only once and is not saved anywhere.');
    const link = await page.getByTestId('invite-link').innerText();
    expect(link).toMatch(/\/invite#/);
    await handover.getByRole('button', { name: 'Copy link' }).click();
    await expect(handover.getByRole('button', { name: 'Copied', exact: true })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(link);
    // Never kept by the page: not in the address, nor in browser storage.
    expect(page.url()).not.toContain('#');
    const stored = await page.evaluate(() =>
      JSON.stringify({ ...window.localStorage, ...window.sessionStorage }),
    );
    expect(stored).not.toContain(link.split('#')[1]);

    const row = page.getByTestId(`org-${slug}`);
    await expect(row).toContainText('Sunrise Synthetic Clinics');
    await expect(row).toContainText('Active');
    await expect(row).toContainText('1 of 1 active');
    await expect(row).toContainText('0 active · 1 invited');

    // Gone once dismissed, and not shown again after a reload.
    await handover.getByRole('button', { name: 'I have copied the link' }).click();
    await expect(page.getByTestId('invite-link')).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId(`org-${slug}`)).toBeVisible();
    await expect(page.getByTestId('invite-link')).toHaveCount(0);

    // The link is the first admin's staff invite.
    const admin = await browser.newPage();
    await admin.goto(link);
    await expect(admin.locator('.summary')).toContainText(
      'You have been invited to Sunrise Synthetic Clinics as Clinic admin.',
    );
    await admin.close();

    // The same ID again is refused next to the field.
    await form.getByLabel('Organisation name').fill('Another Synthetic Clinic');
    await form.getByLabel('Organisation ID').fill(slug);
    await form.getByLabel('First clinic’s name').fill('Another Main');
    await form.getByLabel('First clinic admin’s email or mobile number').fill(`other@${slug}.test`);
    await form.getByRole('button', { name: 'Onboard organisation' }).click();
    await expect(form.getByRole('alert')).toHaveText(
      'Another organisation already uses that ID. Choose another.',
    );
    await expect(form.getByLabel('Organisation ID')).toHaveAttribute('aria-invalid', 'true');
    await expect(form.getByLabel('Organisation ID')).toBeFocused();
    await expect(page.getByTestId('onboard-handover')).toHaveCount(0);
  });

  test('verifies a doctor from the queue, refusing a profile changed meanwhile', async ({
    page,
    operator,
    clinic,
    db,
  }) => {
    const profile = await pendingDoctor(db, clinic);
    await signInToConsole(page, operator);
    await page.getByRole('link', { name: 'Doctor verification' }).first().click();
    await expect(page).toHaveURL(/\/platform\/doctors$/);

    const row = page.getByTestId(`doctor-${profile.id}`);
    await expect(row).toContainText('Dr. Synthetic');
    await expect(row).toContainText('do****@');
    await expect(row).toContainText(clinic.name);
    await expect(row).toContainText(profile.registrationNumber!);
    await expect(row).toContainText('Test Medical Council');
    await expect(row).toContainText('MBBS, MD (Medicine)');
    await expect(row).toContainText('Submitted 1 Jan 2020');

    await row.getByRole('button', { name: 'Verify' }).click();
    const panel = row.getByRole('form', { name: 'Verify doctor' });
    await panel.getByRole('button', { name: 'Verify doctor' }).click();
    await expect(panel.getByRole('alert')).toHaveText(
      'Give the support ticket ID (3 to 40 letters, digits, . _ -).',
    );
    await panel.getByLabel('Support ticket ID').fill(TICKET);
    await panel.getByRole('button', { name: 'Verify doctor' }).click();
    await expect(panel.getByRole('alert')).toHaveText('Confirm that you checked the registration.');
    await panel.getByRole('checkbox').check();

    // The doctor changes their registration while the operator is checking it.
    const changedNumber = `${profile.registrationNumber}-B`;
    await db.doctorProfile.update({
      where: { id: profile.id },
      data: {
        registrationNumber: changedNumber,
        submittedAt: new Date(profile.submittedAt!.getTime() + 1000),
      },
    });
    await panel.getByRole('button', { name: 'Verify doctor' }).click();
    await expect(panel.getByRole('alert')).toHaveText(
      'The doctor changed their registration after this list was loaded, so nothing was verified. Reload the queue and check the new details.',
    );
    expect(
      (await db.doctorProfile.findUniqueOrThrow({ where: { id: profile.id } })).verification,
    ).toBe('pending');
    await panel.getByRole('button', { name: 'Reload queue' }).click();
    await expect(row).toContainText(changedNumber);

    await row.getByRole('button', { name: 'Verify' }).click();
    await row.getByLabel('Support ticket ID').fill(TICKET);
    await row.getByRole('checkbox').check();
    await row.getByRole('button', { name: 'Verify doctor' }).click();
    await expect(page.locator('main [role=status]')).toHaveText(
      'Dr. Synthetic is verified and can now sign prescriptions.',
    );
    await expect(row).toHaveCount(0);

    const saved = await db.doctorProfile.findUniqueOrThrow({ where: { id: profile.id } });
    expect(saved).toMatchObject({
      verification: 'verified',
      registrationNumber: changedNumber,
      verifiedBy: `${operator.email} (${TICKET})`,
    });

    await page.getByRole('tab', { name: 'Verified' }).click();
    await expect(page.getByTestId(`doctor-${profile.id}`)).toContainText(
      `by ${operator.email} (${TICKET})`,
    );
  });

  test('shows usage per organisation for a date range', async ({ page, operator, clinic }) => {
    await signInToConsole(page, operator);
    await page.goto('/platform/usage');

    const row = page.getByTestId(`usage-${clinic.slug}`);
    await expect(row).toContainText(clinic.name);
    // Messaging and the scribe are not built: a dash, with a note, never a zero.
    await expect(row.getByTestId('usage-messages')).toHaveText('—');
    await expect(row.getByTestId('usage-scribe')).toHaveText('—');
    await expect(page.getByTestId('usage-not-built')).toContainText(
      'Messages and scribe minutes are not counted yet',
    );

    const today = await page.getByLabel('To', { exact: true }).inputValue();
    await page.getByLabel('From', { exact: true }).fill('2026-12-31');
    await page.getByLabel('To', { exact: true }).fill('2026-01-01');
    await page.getByRole('button', { name: 'Show' }).click();
    await expect(pageAlert(page)).toHaveText('The start date must be on or before the end date.');
    await expect(page.getByLabel('From', { exact: true })).toHaveAttribute('aria-invalid', 'true');

    await page.getByLabel('From', { exact: true }).fill(today);
    await page.getByLabel('To', { exact: true }).fill(today);
    await page.getByRole('button', { name: 'Show' }).click();
    await expect(page.getByTestId('usage-range')).toHaveText(`${today} to ${today}`);
    await expect(row).toBeVisible();

    await page.getByRole('button', { name: 'हिंदी' }).click();
    await expect(page.locator('h1')).toHaveText('उपयोग');
  });
});
