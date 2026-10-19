import { randomBytes } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import type { Db } from '@dhc/db';
import {
  expect,
  setUpFromInvite,
  signInAsPatient,
  syntheticMobile,
  test,
  type Clinic,
} from '../fixtures';

/** A tiny synthetic PNG (4×4, one colour), built here so no binary file is checked in. */
function tinyPng(rgb: [number, number, number]): Buffer {
  const chunk = (type: string, body: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])));
    return Buffer.concat([head, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(4, 0);
  ihdr.writeUInt32BE(4, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.from([0, ...Array(4).fill(rgb).flat()]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat([row, row, row, row]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** The clinic's doctor with a verified registration and a listed public page. */
async function listDoctor(db: Db, clinic: Clinic, specialty: string) {
  const org = await db.organisation.findUniqueOrThrow({ where: { slug: clinic.slug } });
  const doctor = await db.user.findUniqueOrThrow({ where: { email: clinic.email('doctor') } });
  await db.membership.updateMany({
    where: { organisationId: org.id, userId: doctor.id },
    data: { status: 'active' },
  });
  const slug = `dr-branded-${randomBytes(3).toString('hex')}`;
  await db.doctorProfile.create({
    data: {
      organisationId: org.id,
      userId: doctor.id,
      registrationNumber: `TEST-${randomBytes(3).toString('hex')}`,
      council: 'Test Medical Council',
      qualifications: 'MBBS',
      specialty,
      verification: 'verified',
      verifiedAt: new Date(),
      verifiedBy: 'e2e (SUP-4)',
      publicSlug: slug,
      listed: true,
    },
  });
  return slug;
}

const ACCENT = '#7a1f5c';
const ACCENT_RGB = 'rgb(122, 31, 92)';

test.describe('clinic branding', () => {
  test('the clinic admin sets a name, colour and logo; the doctor page and portal sign-in show them', async ({
    page,
    browser,
    clinic,
    db,
  }) => {
    await setUpFromInvite(page, clinic.inviteLink('clinic_admin'), 'admin synthetic passphrase');
    const form = page.getByTestId('branding-form');
    const preview = page.getByTestId('branding-preview');
    await expect(form.getByLabel('Display name (optional)')).toHaveAttribute(
      'placeholder',
      clinic.name,
    );
    await form.getByLabel('Display name (optional)').fill('Synthetic Family Care');
    await form.getByLabel('Tagline (optional)').fill('Care for every age, synthetic data only');
    await expect(preview).toContainText('Synthetic Family Care');

    // Too light for the white label of a button: shown, and saving is held back.
    const colour = form.getByLabel('Accent colour (optional)');
    await colour.fill('#7fdbca');
    await expect(page.getByTestId('accent-contrast')).toContainText('Contrast with white text:');
    await expect(form.getByRole('alert')).toContainText('Too light for white text');
    await expect(form.getByRole('button', { name: 'Save branding' })).toBeDisabled();
    await colour.fill(ACCENT.toUpperCase());
    await expect(form.getByRole('alert')).toHaveCount(0);
    // The live preview's Book button takes the colour as typed.
    await expect(preview.getByText('Book an appointment')).toHaveCSS(
      'background-color',
      ACCENT_RGB,
    );
    await form.getByRole('button', { name: 'Save branding' }).click();
    await expect(page.getByText('Branding saved.')).toBeVisible();

    // SVG is refused before it is sent; then the tiny PNG.
    const logoInput = page.getByTestId('branding-logo-input');
    await logoInput.setInputFiles({
      name: 'logo.svg',
      mimeType: 'image/svg+xml',
      buffer: Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      ),
    });
    await expect(page.getByText('SVG logos are not accepted.')).toBeVisible();
    await logoInput.setInputFiles({
      name: 'logo.png',
      mimeType: 'image/png',
      buffer: tinyPng([0x7a, 0x1f, 0x5c]),
    });
    await expect(page.getByText('Logo saved.')).toBeVisible();
    await expect(preview.getByTestId('clinic-logo')).toBeVisible();

    // The audit log names the change.
    const org = await db.organisation.findUniqueOrThrow({ where: { slug: clinic.slug } });
    await expect
      .poll(() =>
        db.auditLog.count({
          where: { organisationId: org.id, action: 'organisation.branding_updated' },
        }),
      )
      .toBe(2);

    const tag = randomBytes(3).toString('hex');
    const slug = await listDoctor(db, clinic, `Synthetic branding ${tag}`);

    // An anonymous visitor on the doctor's page.
    const visitor = await browser.newContext({ viewport: { width: 390, height: 844 } });
    try {
      const anon = await visitor.newPage();
      await expect(async () => {
        const response = await anon.goto(`/doctor/${slug}`);
        expect(response?.status()).toBe(200);
      }).toPass({ timeout: 15_000 });
      const brand = anon.getByTestId('clinic-brand');
      await expect(brand).toContainText('Synthetic Family Care');
      const logo = brand.getByTestId('clinic-logo');
      await expect(logo).toBeVisible();
      // The image really loaded from the API's public logo route.
      await expect
        .poll(() => logo.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth))
        .toBe(4);
      await expect(anon.getByTestId('doctor-page')).toContainText('At Synthetic Family Care');
      await expect(anon.getByTestId('book-appointment')).toHaveCSS('background-color', ACCENT_RGB);
      await expect(anon.getByTestId('book-appointment')).toHaveCSS('color', 'rgb(255, 255, 255)');

      // Book: the portal's sign-in for this clinic, with its logo, name, tagline and colour.
      await anon.getByTestId('book-appointment').click();
      await expect(anon).toHaveURL(/\/app\/login\?/);
      const portalBrand = anon.getByTestId('portal-brand');
      await expect(portalBrand).toContainText('Synthetic Family Care');
      await expect(portalBrand).toContainText('Care for every age, synthetic data only');
      await expect(anon.getByTestId('clinic-logo')).toBeVisible();
      await expect(anon.getByRole('button', { name: 'Send code' })).toHaveCSS(
        'background-color',
        ACCENT_RGB,
      );

      // Another clinic typed into the field: the platform look until it is the link's again.
      const clinicField = anon.getByLabel('Clinic ID');
      await clinicField.fill(`${clinic.slug}-other`);
      await expect(portalBrand).toHaveCount(0);
      await expect(anon.getByTestId('clinic-logo')).toHaveCount(0);
      await clinicField.fill(clinic.slug);
      await expect(portalBrand).toContainText('Synthetic Family Care');

      // Without a clinic in the link: the platform look.
      const plain = await visitor.newPage();
      await plain.goto('/app/login');
      await expect(plain.getByLabel('Mobile number')).toBeVisible();
      await expect(plain.getByTestId('portal-brand')).toHaveCount(0);
      await expect(plain.getByTestId('clinic-logo')).toHaveCount(0);

      // The platform's home page stays unbranded, but the card names the clinic by its
      // display name (the web server's list may be a moment old: reload until it has it).
      const search = plain.getByLabel('Search by name, specialty, clinic or address');
      await expect(async () => {
        await plain.goto('/');
        await search.fill(`branding ${tag}`);
        await expect(plain.getByTestId('directory-count')).toHaveText('1 doctor', {
          timeout: 1000,
        });
      }).toPass({ timeout: 15_000 });
      await expect(plain.getByTestId('doctor-card')).toContainText('At Synthetic Family Care');
      await expect(plain.getByTestId('clinic-logo')).toHaveCount(0);
      await expect(plain.getByRole('link', { name: 'Patient sign-in' })).not.toHaveCSS(
        'background-color',
        ACCENT_RGB,
      );
    } finally {
      await visitor.close();
    }

    // Signed in, the portal's frame shows the clinic's name and logo.
    const phone = syntheticMobile();
    await db.patient.create({
      data: {
        organisationId: org.id,
        uhid: 'E2E-000301',
        name: 'Pooja Singh',
        phone: `+91${phone}`,
        dob: new Date('1992-03-14T00:00:00Z'),
        gender: 'female',
      },
    });
    const patient = await browser.newContext();
    try {
      const portal = await patient.newPage();
      await signInAsPatient(portal, db, clinic, phone);
      await expect(portal.getByRole('heading', { name: 'Before you start' })).toBeVisible();
      const frame = portal.getByTestId('portal-brand');
      await expect(frame).toContainText('Synthetic Family Care');
      await expect(frame.getByTestId('clinic-logo')).toBeVisible();
    } finally {
      await patient.close();
    }
  });
});
