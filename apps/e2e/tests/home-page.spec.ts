import { randomBytes } from 'node:crypto';
import { expect, test, type Clinic } from '../fixtures';
import type { Db } from '@dhc/db';

// Phone first: the public pages must work in mobile browsers (Build Plan §5.1).
test.use({ viewport: { width: 390, height: 844 } });

/**
 * A doctor of the test's clinic with a verified registration and, when `slug` is given, a
 * public page address; written straight to the database, as the platform team and the
 * doctor's own settings would leave it (the settings themselves are `doctor-page.spec.ts`).
 */
async function publicDoctor(
  db: Db,
  organisationId: string,
  {
    userId,
    name,
    slug,
    listed,
    verified = true,
    specialty,
  }: {
    userId?: string;
    name: string;
    slug: string;
    listed: boolean;
    verified?: boolean;
    specialty?: string;
  },
) {
  const user = userId
    ? await db.user.update({ where: { id: userId }, data: { displayName: name } })
    : await db.user.create({
        data: { email: `${slug}@${organisationId}.test`, displayName: name },
      });
  if (userId) {
    await db.membership.updateMany({
      where: { organisationId, userId, role: 'doctor' },
      data: { status: 'active' },
    });
  } else {
    await db.membership.create({ data: { organisationId, userId: user.id, role: 'doctor' } });
  }
  await db.doctorProfile.create({
    data: {
      organisationId,
      userId: user.id,
      registrationNumber: `TEST-${randomBytes(3).toString('hex')}`,
      council: 'Test Medical Council',
      qualifications: 'MBBS, MD',
      specialty,
      ...(verified
        ? { verification: 'verified', verifiedAt: new Date(), verifiedBy: 'e2e (SUP-3)' }
        : {}),
      publicSlug: slug,
      listed,
      languages: ['English', 'Hindi'],
    },
  });
  return user;
}

/** A clinic with an address, two consultation types and a weekly schedule for the doctor. */
async function schedule(db: Db, organisationId: string, doctorUserId: string, addressLine: string) {
  const place = await db.clinic.create({
    data: {
      organisationId,
      name: 'Main clinic',
      address: `${addressLine}\nSecond line, not shown`,
    },
  });
  const hours = [{ start: '09:00', end: '10:00' }];
  const weekly = Object.fromEntries(
    ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, hours]),
  );
  for (const [name, feePaise] of [
    ['In-person consultation', 80000],
    ['Short review', 50000],
  ] as const) {
    const type = await db.consultationType.create({
      data: { organisationId, name, mode: 'in_person', defaultDurationMin: 15, feePaise },
    });
    await db.availabilityVersion.create({
      data: {
        organisationId,
        doctorUserId,
        clinicId: place.id,
        consultationTypeId: type.id,
        effectiveFrom: new Date('2026-01-01T00:00:00Z'),
        weekly,
        slotMinutes: 15,
        createdByUserId: doctorUserId,
      },
    });
  }
}

async function setUp(db: Db, clinic: Clinic) {
  const tag = randomBytes(3).toString('hex');
  const org = await db.organisation.findUniqueOrThrow({ where: { slug: clinic.slug } });
  const doctor = await db.user.findUniqueOrThrow({ where: { email: clinic.email('doctor') } });
  const slug = `dr-synthetic-${tag}`;
  const specialty = `Synthetic medicine ${tag}`;
  const addressLine = `1 Synthetic Road, Testpur ${tag}`;
  await publicDoctor(db, org.id, {
    userId: doctor.id,
    name: 'Dr. Synthetic',
    slug,
    listed: true,
    specialty,
  });
  await schedule(db, org.id, doctor.id, addressLine);
  // Never shown: verified but not listed, and listed but not verified.
  await publicDoctor(db, org.id, {
    name: 'Dr. Unlisted Synthetic',
    slug: `dr-unlisted-${tag}`,
    listed: false,
    specialty,
  });
  await publicDoctor(db, org.id, {
    name: 'Dr. Pending Synthetic',
    slug: `dr-pending-${tag}`,
    listed: true,
    verified: false,
    specialty,
  });
  return { tag, slug, specialty, addressLine };
}

test.describe('public home page', () => {
  test('a visitor finds a listed, verified Dr. Synthetic, searches, filters and opens the page; unlisted doctors never show', async ({
    browser,
    clinic,
    db,
  }) => {
    const { tag, slug, specialty, addressLine } = await setUp(db, clinic);

    // An anonymous visitor: a browser with no session at all.
    const visitor = await browser.newContext({ viewport: { width: 390, height: 844 } });
    try {
      const page = await visitor.newPage();
      const response = await page.goto('/');
      expect(response?.status()).toBe(200);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(
        'Find your doctor, book a visit and keep your prescriptions in one place.',
      );
      await expect(page).toHaveTitle(/^Find a doctor and book online/);
      const signIn = page.getByRole('navigation', { name: 'Sign in' });
      await expect(signIn.getByRole('link', { name: 'Patient sign-in' })).toHaveAttribute(
        'href',
        '/app/login',
      );
      await expect(signIn.getByRole('link', { name: 'Clinic staff' })).toHaveAttribute(
        'href',
        '/clinic/login',
      );
      await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
        'href',
        /^http:\/\/localhost:\d+\/$/,
      );
      const jsonLd = JSON.parse((await page.getByTestId('website-json-ld').textContent()) ?? '{}');
      expect(jsonLd).toMatchObject({ '@context': 'https://schema.org', '@type': 'WebSite' });

      // Other tests list doctors too: search narrows it to this one.
      const directory = page.getByTestId('doctor-directory');
      const search = directory.getByLabel('Search by name, specialty, clinic or address');
      const count = page.getByTestId('directory-count');
      const announced = page.getByTestId('directory-count-live');
      await expect(announced).toHaveAttribute('aria-live', 'polite');
      // The web server's copy of the list may be a moment old (it refreshes in the
      // background), so reload until this test's doctor is in it.
      await expect(async () => {
        await page.reload();
        await search.fill(`synthetic ${tag}`);
        await expect(count).toHaveText('1 doctor', { timeout: 1000 });
      }).toPass({ timeout: 15_000 });
      // Screen readers hear the count once typing pauses.
      await expect(announced).toHaveText('1 doctor');
      const card = directory.getByTestId('doctor-card');
      await expect(card).toHaveCount(1);
      await expect(card).toContainText('Dr. Synthetic');
      await expect(card).toContainText('MBBS, MD');
      await expect(card).toContainText(specialty);
      await expect(card).toContainText(`At ${clinic.name}`);
      // The first line of the address only, and the lowest fee.
      await expect(card).toContainText(`Main clinic, ${addressLine}`);
      await expect(card).not.toContainText('Second line');
      await expect(card.getByTestId('fee-from')).toHaveText('From ₹500');
      await expect(card).toHaveAttribute('href', `/doctor/${slug}`);
      await expect(
        directory.getByRole('link', { name: 'Dr. Synthetic: view profile and book' }),
      ).toHaveCount(1);

      // By the address, or the organisation's name.
      await search.fill(`testpur ${tag}`);
      await expect(count).toHaveText('1 doctor');
      await search.fill(`${clinic.slug}`);
      await expect(count).toHaveText('1 doctor');

      // The unlisted and unverified doctors are not in the list at all.
      await search.fill('');
      await expect(page.getByText('Dr. Unlisted Synthetic')).toHaveCount(0);
      await expect(page.getByText('Dr. Pending Synthetic')).toHaveCount(0);
      await search.fill(`unlisted ${tag}`);
      await expect(count).toHaveText('No doctors match your search.');
      await expect(directory.getByTestId('doctor-card')).toHaveCount(0);
      await search.fill(`pending ${tag}`);
      await expect(count).toHaveText('No doctors match your search.');

      // The specialty filter: only this doctor has this specialty.
      await search.fill('');
      await directory
        .getByRole('combobox', { name: 'Specialty' })
        .selectOption({ label: specialty });
      await expect(count).toHaveText('1 doctor');
      await expect(directory.getByTestId('doctor-card')).toContainText('Dr. Synthetic');

      // Hindi, from the toggle and from ?lang=hi.
      await page.getByRole('button', { name: 'हिन्दी' }).click();
      await expect(page.locator('html')).toHaveAttribute('lang', 'hi');
      await expect(page.getByRole('heading', { level: 2, name: 'डॉक्टर खोजें' })).toBeVisible();
      await expect(count).toHaveText('1 डॉक्टर');
      await expect(directory.getByTestId('fee-from')).toHaveText('₹500 से');
      await page.goto('/?lang=hi');
      // Marked Hindi in the server's HTML, before any script runs.
      const html = await (await page.request.get('/?lang=hi')).text();
      expect(html).toMatch(/<div lang="hi"/);
      await expect(page.getByRole('link', { name: 'मरीज़ साइन इन' })).toBeVisible();
      await page.getByRole('button', { name: 'English' }).click();
      await expect(page.locator('html')).toHaveAttribute('lang', 'en');

      // Open the page from its card.
      await search.fill(`dr synthetic ${tag}`);
      await expect(count).toHaveText('1 doctor');
      await directory.getByTestId('doctor-card').click();
      await expect(page).toHaveURL(new RegExp(`/doctor/${slug}$`));
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Dr. Synthetic');
      await expect(page.getByTestId('doctor-page')).toContainText(addressLine);
    } finally {
      await visitor.close();
    }
  });
});
