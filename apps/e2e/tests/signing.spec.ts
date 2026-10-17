import type { Db } from '@dhc/db';
import type { Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { E2E_FILE_STORE_DIR } from '../env';
import { expect, setUpFromInvite, test, type Clinic } from '../fixtures';
import { pdfText } from '../pdf-text';

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

/**
 * The prescription pad and a signing PIN in the browser, then the platform team's
 * verification (written straight to the database here).
 */
async function padAndPin(
  page: Page,
  db: Db,
  { org, doctor }: Awaited<ReturnType<typeof setUp>>,
  prefix: string,
) {
  await page.goto('/clinic/profile');
  const pad = page.getByTestId('profile-form');
  await expect(pad).toContainText('Waiting for verification by the platform team');
  await pad.getByLabel('Registration number').fill('TEST-12345');
  await pad.getByLabel('Medical council').fill('Test Medical Council');
  await pad.getByLabel('Qualifications').fill('MBBS, MS (Ortho)');
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
}

test.describe('signing', () => {
  test('the doctor fills the pad, signs with the PIN, amends, and voids; the QR page follows; the front desk prints', async ({
    page,
    browser,
    clinic,
    db,
  }) => {
    // Doctor and front desk each sign in and work in their own browser: allow for slow CI runners.
    test.setTimeout(120_000);
    await setUpFromInvite(page, clinic.inviteLink('doctor'), PASSWORD);
    const ready = await setUp(db, clinic);
    const { visit } = ready;

    // The prescription pad, then the platform team's verification. Prefixes are unique
    // within a clinic; each test has its own clinic.
    const prefix = 'SD';
    await padAndPin(page, db, ready, prefix);

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

    // The front desk prints it from the queue card, in its own browser.
    const desk = await (
      await browser.newContext({ baseURL: test.info().project.use.baseURL })
    ).newPage();
    await setUpFromInvite(desk, clinic.inviteLink('front_desk'), 'desk synthetic passphrase');
    await desk.goto('/clinic/queue');
    const patient = await db.patient.findUniqueOrThrow({ where: { id: visit.patientId } });
    const deskCard = desk.getByTestId(`appointment-${patient.uhid}`);
    const deskPdf = desk.waitForResponse(
      (r) => r.request().method() === 'GET' && /\/prescriptions\/[^/]+\/pdf$/.test(r.url()),
    );
    const deskTab = desk.waitForEvent('popup');
    await deskCard.getByRole('button', { name: `Print prescription ${prefix}-00001` }).click();
    const printed = await deskPdf;
    expect(printed.status()).toBe(200);
    expect(printed.headers()['content-type']).toBe('application/pdf');
    await (await deskTab).close();

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

    // The front desk's card now offers the copy stamped VOID.
    await desk.reload();
    await expect(
      deskCard.getByRole('button', { name: `Prescription ${prefix}-00001 (void)` }),
    ).toBeVisible();
  });

  test('the doctor orders an MRI knee, right and an X-ray, signs, and reviews the result the front desk uploads', async ({
    page,
    browser,
    clinic,
    db,
  }) => {
    test.setTimeout(120_000);
    await setUpFromInvite(page, clinic.inviteLink('doctor'), PASSWORD);
    const ready = await setUp(db, clinic);
    await padAndPin(page, db, ready, 'OR');

    // Tests next to the medicines: the catalogue, then region, side and views for imaging.
    await page.goto(`/clinic/consultations/${ready.visit.id}`);
    const rx = page.getByTestId('prescription');
    const tests = rx.getByTestId('tests-section');
    const search = tests.getByLabel('Add test: search blood tests, X-ray, MRI, CT');
    await search.fill('mri');
    await tests.getByRole('option', { name: 'MRI', exact: true }).click();
    const picker = tests.getByTestId('test-picker');
    await expect(picker.getByRole('button', { name: 'Add test' })).toBeDisabled();
    await picker.getByLabel('Region').selectOption('Knee');
    await picker.getByLabel('Side').selectOption('right');
    await expect(picker).toContainText('Prints as: MRI knee, right');
    await picker.getByRole('button', { name: 'Add test' }).click();

    await search.fill('x-ray');
    await tests.getByRole('option', { name: 'X-ray', exact: true }).click();
    await picker.getByLabel('Region').selectOption('Knee');
    await picker.getByLabel('Side').selectOption('both');
    await picker.getByLabel('AP', { exact: true }).check();
    await picker.getByLabel('Lateral', { exact: true }).check();
    await picker.getByRole('button', { name: 'Add test' }).click();
    await tests
      .getByTestId('test-line-0')
      .getByLabel('Notes for the lab (printed)')
      .fill('Rule out ACL tear');

    await expect(tests.getByTestId('test-line-0').getByTestId('test-label')).toHaveText(
      'MRI knee, right',
    );
    await expect(tests.getByTestId('test-line-1').getByTestId('test-label')).toHaveText(
      'X-ray knee, both sides (AP, Lateral)',
    );
    await expect(rx.getByTestId('rx-save-status')).toHaveText('Saved');
    // Autosaved with the prescription: still there after a reload.
    await page.reload();
    await expect(tests.getByTestId('test-line-1').getByTestId('test-label')).toHaveText(
      'X-ray knee, both sides (AP, Lateral)',
    );
    await expect(
      tests.getByTestId('test-line-0').getByLabel('Notes for the lab (printed)'),
    ).toHaveValue('Rule out ACL tear');

    // Sign: tests alone are enough. They lock with the prescription.
    const panel = rx.getByTestId('sign-panel');
    await panel.getByRole('button', { name: 'Sign prescription' }).click();
    await panel.getByLabel('Signing PIN').fill(PIN);
    await panel.getByRole('button', { name: 'Sign now' }).click();
    await expect(panel).toContainText('Rx OR-00001, version 1');
    await expect(tests.getByTestId('test-line-0')).toContainText(
      'Ordered on the signed prescription',
    );
    await expect(tests.getByLabel('Add test: search blood tests, X-ray, MRI, CT')).toHaveCount(0);

    // The signed PDF prints them under "Prescribed tests". It opens like any other; its
    // text is read from the stored file, which must be the one signed (same hash).
    const pdf = page.waitForResponse(
      (r) => r.request().method() === 'GET' && /\/prescriptions\/[^/]+\/pdf$/.test(r.url()),
    );
    const tab = page.waitForEvent('popup');
    await panel.getByRole('button', { name: 'Open PDF' }).click();
    expect((await pdf).status()).toBe(200);
    await (await tab).close();
    const signed = await db.prescription.findFirstOrThrow({
      where: { appointmentId: ready.visit.id, status: 'signed' },
    });
    const file = await readFile(join(E2E_FILE_STORE_DIR, signed.pdfFileKey!));
    expect(createHash('sha256').update(file).digest('hex')).toBe(signed.pdfSha256);
    const text = pdfText(file);
    expect(text).toContain('Prescribed tests 1. MRI knee, right Rule out ACL tear');
    expect(text).toContain('2. X-ray knee, both sides (AP, Lateral)');

    // The pharmacist's QR page lists them too, labels only, in English and Hindi.
    const qr = await page.context().newPage();
    await qr.goto(`/verify/${signed.verificationCode}`);
    const qrTests = qr.getByTestId('verify-tests');
    await expect(qrTests).toContainText('Prescribed tests');
    await expect(qrTests).toContainText('MRI knee, right');
    await expect(qrTests).toContainText('X-ray knee, both sides (AP, Lateral)');
    await expect(qrTests).not.toContainText('Rule out ACL tear');
    await qr.getByRole('button', { name: 'हिन्दी' }).click();
    await expect(qrTests).toContainText('लिखी गई जाँचें');
    await qr.close();

    // The front desk uploads the MRI report from the patient's profile, in its own browser.
    const desk = await (
      await browser.newContext({ baseURL: test.info().project.use.baseURL })
    ).newPage();
    await setUpFromInvite(desk, clinic.inviteLink('front_desk'), 'desk synthetic passphrase');
    await desk.goto(`/clinic/patients/${ready.visit.patientId}`);
    const deskOrders = desk.getByTestId('test-orders');
    const deskMri = deskOrders.getByTestId('test-order-MRI knee, right');
    await expect(deskMri.getByTestId('test-order-status')).toHaveText('Ordered');
    // The doctor's notes stay with the doctor.
    await expect(deskMri).not.toContainText('Rule out ACL tear');
    await deskMri.getByLabel('Upload result for MRI knee, right').setInputFiles({
      name: 'mri-report.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.7\n% synthetic MRI report\n'),
    });
    await expect(deskOrders.getByRole('status')).toHaveText(
      'Result uploaded. The doctor will see it to review.',
    );
    await expect(deskMri.getByTestId('test-order-status')).toHaveText('Result uploaded');
    await expect(deskMri).toContainText('Result 1 · from the clinic');
    await expect(deskMri.getByRole('button', { name: /Result 1/ })).toHaveCount(0);

    // The doctor is told on the dashboard, opens the result and marks it reviewed.
    await page.goto('/clinic');
    const awaiting = page.getByTestId('results-awaiting');
    await expect(awaiting.getByTestId('results-awaiting-count')).toHaveText('1 waiting');
    await expect(awaiting).toContainText('MRI knee, right');
    await awaiting.getByRole('link', { name: 'Asha Verma' }).click();
    const mri = page.getByTestId('test-orders').getByTestId('test-order-MRI knee, right');
    await expect(mri).toContainText('Rule out ACL tear');
    const result = page.waitForResponse(
      (r) => r.request().method() === 'GET' && /\/test-results\/[^/]+\/file$/.test(r.url()),
    );
    const resultTab = page.waitForEvent('popup');
    await mri.getByRole('button', { name: /Result 1 · from the clinic/ }).click();
    expect((await result).status()).toBe(200);
    await (await resultTab).close();
    await mri.getByRole('button', { name: 'Mark reviewed' }).click();
    await expect(mri.getByTestId('test-order-status')).toHaveText('Reviewed');
    await expect(mri).toContainText('Reviewed');
    await page.goto('/clinic');
    await expect(page.getByTestId('results-awaiting')).toContainText(
      'No results waiting for review.',
    );
  });
});
