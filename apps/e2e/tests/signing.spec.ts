import type { Db } from '@dhc/db';
import { expect, setUpFromInvite, test, type Clinic } from '../fixtures';

const PASSWORD = 'doctor synthetic passphrase';
const PIN = '482916';

const istDay = (days = 0) =>
  new Date(Date.now() + (330 + days * 24 * 60) * 60_000).toISOString().slice(0, 10);

/** An active doctor and Asha in consultation today. Drug facts are the synthetic sample. */
async function setUp(db: Db, clinic: Clinic) {
  const org = await db.organisation.findUniqueOrThrow({ where: { slug: clinic.slug } });
  const doctor = await db.user.findUniqueOrThrow({ where: { email: clinic.email('doctor') } });
  await db.membership.updateMany({
    where: { organisationId: org.id, userId: doctor.id },
    data: { status: 'active' },
  });
  const place = await db.clinic.create({ data: { organisationId: org.id, name: 'Main clinic' } });
  const type = await db.consultationType.create({
    data: {
      organisationId: org.id,
      name: 'In-person consultation',
      mode: 'in_person',
      defaultDurationMin: 15,
      feePaise: 80000,
    },
  });
  const patient = await db.patient.findFirstOrThrow({
    where: { organisationId: org.id },
    orderBy: { uhid: 'asc' },
  });
  const startAt = new Date();
  const visit = await db.appointment.create({
    data: {
      organisationId: org.id,
      patientId: patient.id,
      doctorUserId: doctor.id,
      clinicId: place.id,
      consultationTypeId: type.id,
      date: new Date(`${istDay(0)}T00:00:00Z`),
      startAt,
      endAt: new Date(startAt.getTime() + 15 * 60_000),
      status: 'in_consultation',
      source: 'walk_in',
      tokenNumber: 1,
      checkedInAt: startAt,
      consultationStartedAt: startAt,
      createdByUserId: doctor.id,
    },
  });
  return { org, doctor, visit };
}

test.describe('signing', () => {
  test('the doctor fills the pad, signs with the PIN, amends, and voids; the QR page follows', async ({
    page,
    clinic,
    db,
  }) => {
    await setUpFromInvite(page, clinic.inviteLink('doctor'), PASSWORD);
    const { org, doctor, visit } = await setUp(db, clinic);

    // The prescription pad, then the platform team's verification.
    await page.goto('/clinic/profile');
    const pad = page.getByTestId('profile-form');
    await expect(pad).toContainText('Waiting for verification by the platform team');
    await pad.getByLabel('Registration number').fill('TEST-12345');
    await pad.getByLabel('Medical council').fill('Test Medical Council');
    await pad.getByLabel('Qualifications').fill('MBBS, MS (Ortho)');
    // Prefixes are unique within a clinic; each test has its own clinic.
    const prefix = 'SD';
    await pad.getByLabel('Prescription number prefix').fill(prefix);
    await pad.getByRole('button', { name: 'Save' }).click();
    await expect(pad.getByRole('status')).toHaveText('Saved.');

    const pinForm = page.getByTestId('pin-form');
    await pinForm.getByLabel('Account password').fill(PASSWORD);
    await pinForm.getByLabel('New PIN').fill(PIN);
    await pinForm.getByLabel('Repeat the PIN').fill(PIN);
    await pinForm.getByRole('button', { name: 'Save PIN' }).click();
    await expect(pinForm.getByRole('status')).toHaveText('PIN saved.');
    await db.doctorProfile.update({
      where: { organisationId_userId: { organisationId: org.id, userId: doctor.id } },
      data: { verification: 'verified', verifiedAt: new Date(), verifiedBy: 'e2e (SUP-1)' },
    });

    // A line, then sign with the PIN.
    await page.goto(`/clinic/consultations/${visit.id}`);
    const rx = page.getByTestId('prescription');
    await rx.getByLabel('Add medicine: search name or composition').fill('parace');
    await rx.getByRole('option', { name: /^Paracetamol 500/ }).click();
    await rx.getByTestId('rx-line-0').getByLabel('Frequency').fill('1-0-1');
    await expect(rx.getByTestId('rx-save-status')).toHaveText('Saved');

    const panel = rx.getByTestId('sign-panel');
    await panel.getByRole('button', { name: 'Sign prescription' }).click();
    await panel.getByLabel('Signing PIN').fill('000000');
    await panel.getByRole('button', { name: 'Sign now' }).click();
    await expect(panel.getByRole('alert')).toHaveText('That PIN is not right.');
    await panel.getByLabel('Signing PIN').fill(PIN);
    await panel.getByRole('button', { name: 'Sign now' }).click();
    await expect(panel).toContainText(`Rx ${prefix}-00001, version 1`);
    await expect(panel).toContainText('Signed');
    await expect(panel).toContainText('Test signature: not legally valid');
    // The lines and the visit record are locked.
    await expect(rx.getByTestId('rx-line-0').getByLabel('Frequency')).toBeDisabled();

    // The PDF opens in a new tab (headless Chromium saves it instead of showing it).
    const pdf = page.waitForResponse(
      (r) => r.request().method() === 'GET' && /\/prescriptions\/[^/]+\/pdf$/.test(r.url()),
    );
    const tab = page.waitForEvent('popup');
    await panel.getByRole('button', { name: 'Open PDF' }).click();
    const response = await pdf;
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toBe('application/pdf');
    await (await tab).close();

    // The QR page says Genuine, with initials only.
    const v1 = await db.prescription.findFirstOrThrow({
      where: { appointmentId: visit.id, version: 1 },
    });
    const qr = await page.context().newPage();
    await qr.goto(`/verify/${v1.verificationCode}`);
    await expect(qr.getByTestId('verify-status')).toHaveText('Genuine');
    await expect(qr.getByTestId('verify-result')).toContainText(`${prefix}-00001`);
    await expect(qr.getByTestId('verify-result')).toContainText('Paracetamol 500');
    await qr.getByRole('button', { name: 'हिन्दी' }).click();
    await expect(qr.getByTestId('verify-status')).toHaveText('असली');

    // Amend: version 2, edited and signed; version 1 is superseded.
    await panel.getByRole('button', { name: 'Amend' }).click();
    await panel.getByLabel('Reason for the amendment').fill('Dose corrected');
    await panel.getByRole('button', { name: 'Start amendment' }).click();
    await expect(rx.getByTestId('sign-panel')).toContainText('Amending version 1: Dose corrected');
    await rx.getByTestId('rx-line-0').getByLabel('Frequency').fill('1-1-1');
    await expect(rx.getByTestId('rx-save-status')).toHaveText('Saved');
    await panel.getByRole('button', { name: 'Sign prescription' }).click();
    await panel.getByLabel('Signing PIN').fill(PIN);
    await panel.getByRole('button', { name: 'Sign now' }).click();
    await expect(panel).toContainText(`Rx ${prefix}-00001, version 2`);
    await expect(panel.getByRole('listitem').filter({ hasText: 'version 1' })).toContainText(
      'Superseded',
    );
    // Reloading starts again in English.
    await qr.reload();
    await expect(qr.getByTestId('verify-status')).toHaveText('Superseded');
    await expect(qr.getByTestId('verify-result')).toContainText('version 2');

    // Void the current version with a reason and the PIN.
    await panel.getByRole('button', { name: 'Void' }).click();
    await panel.getByLabel('Reason for voiding').fill('Wrong patient');
    await panel.getByLabel('Signing PIN').fill(PIN);
    await panel.getByRole('button', { name: 'Void prescription' }).click();
    await expect(panel).toContainText('Void since');
    await expect(panel).toContainText('Wrong patient');
    const v2 = await db.prescription.findFirstOrThrow({
      where: { appointmentId: visit.id, version: 2 },
    });
    expect(v2.status).toBe('void');
    await qr.goto(`/verify/${v2.verificationCode}`);
    await expect(qr.getByTestId('verify-status')).toHaveText('Void');
  });
});
