import { createHmac, hkdfSync } from 'node:crypto';
import { expect, signInAsPatient, syntheticMobile, test } from '../fixtures';
import { E2E_JWT_SECRET } from '../env';
import { samplePng } from '../../api/src/modules/branding/logo-samples';
const hash = (id: string, code: string) =>
  createHmac(
    'sha256',
    Buffer.from(hkdfSync('sha256', E2E_JWT_SECRET, 'dhc-otp', 'otp-code-hash', 32)),
  )
    .update(`${id}:${code}`)
    .digest('base64url');
for (const width of [390, 1280])
  test(`patient edits a private profile and verifies an old/new phone change (${width}px)`, async ({
    page,
    db,
    clinic,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const org = await db.organisation.findUniqueOrThrow({ where: { slug: clinic.slug } }),
      person = await db.patient.findFirstOrThrow({ where: { organisationId: org.id } }),
      phone = syntheticMobile(),
      nextPhone = syntheticMobile();
    await db.patient.update({
      where: { id: person.id },
      data: {
        name: 'Profile Patient',
        phone: '+91' + phone,
        dob: new Date('1992-03-14'),
        gender: 'female',
      },
    });
    const child = await db.patient.create({
      data: {
        organisationId: org.id,
        uhid: 'PROFILE-CHILD',
        name: 'Profile Child',
        dob: new Date('2020-01-01'),
        gender: 'male',
        guardianPatientId: person.id,
      },
    });
    await signInAsPatient(page, db, clinic, phone);
    await page.getByRole('checkbox', { name: 'I have read the privacy notice' }).check();
    await page.getByRole('checkbox', { name: 'I accept the terms of use' }).check();
    await page.getByRole('checkbox', { name: /health records/i }).check();
    await page.getByRole('button', { name: 'Accept and continue' }).click();
    await page.getByRole('navigation').getByRole('link', { name: 'Family' }).click();
    await page
      .getByTestId('family-member')
      .filter({ has: page.getByText('Profile Patient', { exact: true }) })
      .getByRole('link', { name: 'Edit profile' })
      .click();
    await expect(page.getByRole('heading', { name: 'Edit profile', exact: true })).toBeVisible();
    await page.getByLabel('Full name', { exact: true }).fill('Updated Profile Patient');
    await page.getByLabel('Email', { exact: true }).fill('profile@example.test');
    await page.getByLabel('Address', { exact: true }).fill('Synthetic test address');
    await page.getByLabel('Emergency contact name', { exact: true }).fill('Emergency Person');
    await page.getByLabel('Emergency contact mobile', { exact: true }).fill('9876543212');
    await page
      .getByRole('combobox', { name: 'Patient-reported blood group', exact: true })
      .selectOption('O+');
    await page.getByRole('button', { name: 'Save profile', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Profile saved.');
    await page.getByRole('navigation').getByRole('link', { name: 'Family' }).click();
    const updated = page
      .getByTestId('family-member')
      .filter({ has: page.getByText('Updated Profile Patient', { exact: true }) });
    await expect(updated).toBeVisible();
    await updated.getByRole('link', { name: 'Edit profile' }).click();

    await expect(
      page.getByText('O+ · Pending doctor verification', { exact: false }),
    ).toBeVisible();
    const allergies = page.getByRole('heading', { name: 'Allergies', exact: true }).locator('..');
    await allergies.getByLabel('Reported name').fill('Penicillin');
    await allergies.getByLabel('Reaction').fill('Rash');
    await allergies.getByRole('button', { name: 'Add patient-reported entry' }).click();
    await expect(allergies.getByRole('list')).toContainText(
      'Penicillin · Pending doctor verification',
    );
    expect(await db.allergy.findFirst({ where: { patientId: person.id } })).toMatchObject({
      source: 'patient',
      substance: 'Penicillin',
    });
    await page
      .getByLabel('Choose profile photo')
      .setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: samplePng() });
    await expect(page.getByRole('img', { name: 'Profile photo', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Remove photo', exact: true }).click();
    await expect(page.getByRole('img', { name: 'Profile photo', exact: true })).toHaveCount(0);
    await page.getByLabel('New mobile number', { exact: true }).fill(nextPhone);
    await page.getByRole('button', { name: 'Send codes to both numbers' }).click();
    await expect(page.getByLabel('Code from old number')).toBeVisible();
    const change = await db.patientPhoneChange.findFirstOrThrow({
      where: { patientId: person.id },
      orderBy: { createdAt: 'desc' },
    });
    await db.otpChallenge.update({
      where: { id: change.oldChallengeId! },
      data: { codeHash: hash(change.oldChallengeId!, '135790') },
    });
    await db.otpChallenge.update({
      where: { id: change.newChallengeId! },
      data: { codeHash: hash(change.newChallengeId!, '246801') },
    });
    await page.getByLabel('Code from old number').fill('135790');
    await page.getByLabel('Code from new number').fill('246801');
    await page.getByRole('button', { name: 'Verify both codes and change number' }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Number changed for this clinic.' }),
    ).toContainText('Number changed for this clinic.');
    await page.getByRole('button', { name: 'Go to sign-in' }).click();
    await expect(page).toHaveURL(/\/app\/login/);
    await signInAsPatient(page, db, clinic, nextPhone);
    await page.getByRole('checkbox', { name: 'I have read the privacy notice' }).check();
    await page.getByRole('checkbox', { name: 'I accept the terms of use' }).check();
    await page.getByRole('checkbox', { name: /health records/i }).check();
    await page.getByRole('button', { name: 'Accept and continue' }).click();
    await expect(
      page.getByRole('heading', { name: 'Welcome, Updated Profile Patient' }),
    ).toBeVisible();
    await page.getByRole('navigation').getByRole('link', { name: 'Family' }).click();
    await expect(
      page.getByTestId('family-member').filter({ hasText: 'Profile Child' }),
    ).toBeVisible();
    expect(await db.patient.findUnique({ where: { id: person.id } })).toMatchObject({
      phone: '+91' + nextPhone,
      uhid: person.uhid,
      address: 'Synthetic test address',
    });
    expect(await db.patient.findUnique({ where: { id: child.id } })).toMatchObject({
      guardianPatientId: person.id,
      phone: null,
    });
  });
