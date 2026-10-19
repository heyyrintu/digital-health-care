import { randomBytes } from 'node:crypto';
import {
  enterPatientCode,
  expect,
  setUpFromInvite,
  setUpPrescriptionPad,
  syntheticMobile,
  test,
} from '../fixtures';

// Phone first: the public pages must work in mobile browsers (Build Plan §5.1).
test.use({ viewport: { width: 390, height: 844 } });

test.describe('public doctor page', () => {
  test('Dr. Synthetic lists their page; an anonymous visitor finds it, sees the markup and books through the portal', async ({
    page,
    browser,
    clinic,
    db,
  }) => {
    // The doctor sets up, and the platform team verifies the registration.
    await setUpFromInvite(page, clinic.inviteLink('doctor'), 'synthetic-doctor-passphrase');
    await setUpPrescriptionPad(page, db, clinic, {
      prefix: 'DS',
      password: 'synthetic-doctor-passphrase',
      pin: '482916',
    });

    // Where the doctor sees patients: a clinic, a consultation and a weekly schedule; and a
    // second doctor, so the portal has a choice to make.
    const org = await db.organisation.findUniqueOrThrow({ where: { slug: clinic.slug } });
    const doctor = await db.user.findUniqueOrThrow({ where: { email: clinic.email('doctor') } });
    const place = await db.clinic.create({
      data: { organisationId: org.id, name: 'Main clinic', address: '1 Synthetic Road, Testpur' },
    });
    const type = await db.consultationType.create({
      data: {
        organisationId: org.id,
        name: 'In-person consultation',
        mode: 'in_person',
        defaultDurationMin: 20,
        feePaise: 80000,
      },
    });
    const hours = [{ start: '09:00', end: '10:00' }];
    const weekly = Object.fromEntries(
      ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, hours]),
    );
    const other = await db.user.create({
      data: { email: `other@${clinic.slug}.test`, displayName: 'Dr. Another' },
    });
    await db.membership.create({
      data: { organisationId: org.id, userId: other.id, role: 'doctor' },
    });
    for (const doctorUserId of [doctor.id, other.id]) {
      await db.availabilityVersion.create({
        data: {
          organisationId: org.id,
          doctorUserId,
          clinicId: place.id,
          consultationTypeId: type.id,
          effectiveFrom: new Date('2026-01-01T00:00:00Z'),
          weekly,
          slotMinutes: 20,
          createdByUserId: doctor.id,
        },
      });
    }

    // The doctor's public page settings, on the profile page.
    const slug = `dr-synthetic-${randomBytes(3).toString('hex')}`;
    await page.reload();
    const form = page.getByTestId('public-page-form');
    await expect(page.getByTestId('public-page-status')).toHaveText(
      'Your page is hidden: it is not listed.',
    );
    // Listing needs an address.
    await form.getByRole('checkbox', { name: 'Show my public page' }).check();
    await form.getByRole('button', { name: 'Save public page' }).click();
    await expect(form.getByRole('alert')).toHaveText('Choose a page address to list your page.');
    await form.getByLabel('Page address').fill('Not valid!');
    await form.getByRole('button', { name: 'Save public page' }).click();
    await expect(form.getByRole('alert')).toHaveText(
      'Use 3 to 60 lowercase letters, digits and single hyphens.',
    );
    await form.getByLabel('Page address').fill(slug);
    await form
      .getByLabel('About you (optional)')
      .fill('Synthetic family physician. This text is test data only.');
    await form.getByLabel('Languages you consult in').fill('English, Hindi');
    await form.getByRole('button', { name: 'Save public page' }).click();
    await expect(form.getByRole('status')).toHaveText('Public page saved.');
    await expect(page.getByTestId('public-page-status')).toHaveText('Your page is live.');
    await expect(page.getByTestId('public-page-link')).toHaveAttribute('href', `/doctor/${slug}`);

    // Two pages that must not show: Dr. Another lists one but is not verified, and a
    // verified doctor has an address but did not list it.
    const unverifiedSlug = `dr-unverified-${randomBytes(3).toString('hex')}`;
    const unlistedSlug = `dr-unlisted-${randomBytes(3).toString('hex')}`;
    await db.doctorProfile.create({
      data: { organisationId: org.id, userId: other.id, publicSlug: unverifiedSlug, listed: true },
    });
    const hidden = await db.user.create({
      data: { email: `hidden@${clinic.slug}.test`, displayName: 'Dr. Hidden' },
    });
    await db.membership.create({
      data: { organisationId: org.id, userId: hidden.id, role: 'doctor' },
    });
    await db.doctorProfile.create({
      data: {
        organisationId: org.id,
        userId: hidden.id,
        registrationNumber: 'TEST-99999',
        council: 'Test Medical Council',
        qualifications: 'MBBS',
        verification: 'verified',
        verifiedAt: new Date(),
        verifiedBy: 'e2e (SUP-2)',
        publicSlug: unlistedSlug,
        listed: false,
      },
    });

    // An anonymous visitor: a browser with no session at all.
    const visitor = await browser.newContext({ viewport: { width: 390, height: 844 } });
    try {
      const anon = await visitor.newPage();
      const response = await anon.goto(`/doctor/${slug}`);
      expect(response?.status()).toBe(200);
      await expect(anon.getByRole('heading', { level: 1 })).toHaveText('Dr. Synthetic');
      await expect(anon).toHaveTitle(/^Dr\. Synthetic/);
      const doctorPage = anon.getByTestId('doctor-page');
      await expect(doctorPage).toContainText('MBBS, MS (Ortho)');
      // The badge sits with the number: that is what the platform team checked.
      const registration = anon.getByTestId('registration');
      await expect(registration).toContainText('TEST-12345');
      await expect(registration).toContainText('Registration number verified');
      await expect(registration).toContainText('Test Medical Council');
      await expect(doctorPage).toContainText('Synthetic family physician.');
      await expect(doctorPage).toContainText('1 Synthetic Road, Testpur');
      await expect(anon.getByTestId('consultation-types')).toContainText('In-person consultation');
      await expect(anon.getByTestId('consultation-types')).toContainText('₹800');

      // Search engines get the schema markup and a canonical address.
      const jsonLd = JSON.parse(
        (await anon.getByTestId('physician-json-ld').textContent()) ?? '{}',
      );
      expect(jsonLd).toMatchObject({
        '@context': 'https://schema.org',
        '@type': 'Physician',
        name: 'Dr. Synthetic',
        knowsLanguage: ['English', 'Hindi'],
        hasCredential: { identifier: 'TEST-12345' },
        parentOrganization: { name: clinic.name },
      });
      expect(String(jsonLd.url)).toMatch(new RegExp(`/doctor/${slug}$`));
      await expect(anon.locator('link[rel="canonical"]')).toHaveAttribute(
        'href',
        new RegExp(`/doctor/${slug}$`),
      );

      // Hindi.
      await anon.getByRole('button', { name: 'हिन्दी' }).click();
      await expect(anon.getByTestId('book-appointment')).toHaveText('अपॉइंटमेंट बुक करें');
      await expect(anon.locator('html')).toHaveAttribute('lang', 'hi');
      await anon.getByRole('button', { name: 'English' }).click();

      // Missing, listed but unverified, and verified but unlisted: the same 404 page.
      for (const hiddenSlug of ['dr-nobody-here', unverifiedSlug, unlistedSlug]) {
        const missing = await anon.goto(`/doctor/${hiddenSlug}`);
        expect(missing?.status(), hiddenSlug).toBe(404);
        await expect(anon.getByRole('heading', { name: 'Page not found' })).toBeVisible();
        await expect(anon.getByText('Dr. Another')).toHaveCount(0);
        await expect(anon.getByText('Dr. Hidden')).toHaveCount(0);
      }

      // Book: sign in at the doctor's clinic, then the booking page with the doctor picked.
      const phone = syntheticMobile();
      await db.patient.create({
        data: {
          organisationId: org.id,
          uhid: 'E2E-000201',
          name: 'Pooja Singh',
          phone: `+91${phone}`,
          dob: new Date('1992-03-14T00:00:00Z'),
          gender: 'female',
        },
      });
      await anon.goto(`/doctor/${slug}`);
      await anon.getByTestId('book-appointment').click();
      await expect(anon).toHaveURL(/\/app\/login\?/);
      await enterPatientCode(anon, db, clinic, phone);
      await expect(anon.getByRole('heading', { name: 'Before you start' })).toBeVisible();
      await anon.getByRole('checkbox', { name: 'I have read the privacy notice' }).check();
      await anon.getByRole('checkbox', { name: 'I accept the terms of use' }).check();
      await anon.getByRole('checkbox', { name: /health records/i }).check();
      await anon.getByRole('button', { name: 'Accept and continue' }).click();
      await expect(anon).toHaveURL(new RegExp(`/app/book\\?doctor=${slug}$`));
      await expect(anon.getByRole('button', { name: 'Dr. Synthetic' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await expect(anon.getByRole('button', { name: 'Dr. Another' })).toHaveAttribute(
        'aria-pressed',
        'false',
      );

      // A link naming a doctor this clinic does not list picks nobody: the patient chooses.
      await anon.goto(`/app/book?doctor=${unverifiedSlug}`);
      await expect(
        anon.getByText('The doctor from that link does not take online bookings here.'),
      ).toBeVisible();
      for (const name of ['Dr. Synthetic', 'Dr. Another']) {
        await expect(anon.getByRole('button', { name })).toHaveAttribute('aria-pressed', 'false');
      }
      await expect(anon.getByTestId('slots')).toContainText('Choose a doctor first.');

      // Signed in here, a link for another clinic does not book here: sign out first.
      const elsewhere = `${clinic.slug}-elsewhere`;
      await anon.goto(
        `/app/login?clinic=${elsewhere}&next=${encodeURIComponent(`/app/book?doctor=${slug}`)}`,
      );
      await expect(anon.getByTestId('other-clinic')).toContainText(
        `You are signed in at ${clinic.name}. Sign out to book at ${elsewhere}.`,
      );
      await expect(anon).toHaveURL(/\/app\/login\?/);
      await anon.getByTestId('other-clinic').getByRole('button', { name: 'Sign out' }).click();
      await expect(anon.getByLabel('Clinic ID')).toHaveValue(elsewhere);
    } finally {
      await visitor.close();
    }
  });
});
