import type { Db } from '@dhc/db';
import { pdfText } from '@dhc/pdf-text';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { E2E_FILE_STORE_DIR } from '../env';
import { expect, setUpFromInvite, setUpPrescriptionPad, test, type Clinic } from '../fixtures';

const WEB_URL = 'http://localhost:3300';
const today = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

/** A second doctor for the clinic, invited like the seeded staff; returns the invite link. */
async function inviteSecondDoctor(db: Db, clinic: Clinic) {
  const org = await db.organisation.findUniqueOrThrow({ where: { slug: clinic.slug } });
  const user = await db.user.create({
    data: { email: `second-doctor@${clinic.slug}.test`, displayName: 'Dr. Second Synthetic' },
  });
  await db.membership.create({
    data: { organisationId: org.id, userId: user.id, role: 'doctor', status: 'invited' },
  });
  const token = randomBytes(32).toString('base64url');
  await db.staffInvite.create({
    data: {
      organisationId: org.id,
      userId: user.id,
      role: 'doctor',
      tokenHash: createHash('sha256').update(token).digest('base64url'),
      createdByUserId: user.id,
      expiresAt: new Date(Date.now() + 72 * 3600_000),
    },
  });
  return `${WEB_URL}/invite#${token}`;
}

/** Today's visit with the clinic's first doctor, in consultation, and "own patients only". */
async function visitInConsultation(db: Db, clinic: Clinic) {
  const org = await db.organisation.findUniqueOrThrow({ where: { slug: clinic.slug } });
  const doctor = await db.user.findUniqueOrThrow({ where: { email: clinic.email('doctor') } });
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
  const now = new Date();
  const visit = await db.appointment.create({
    data: {
      organisationId: org.id,
      patientId: patient.id,
      doctorUserId: doctor.id,
      clinicId: place.id,
      consultationTypeId: type.id,
      date: new Date(`${today()}T00:00:00Z`),
      startAt: now,
      endAt: new Date(now.getTime() + 15 * 60_000),
      status: 'in_consultation',
      source: 'walk_in',
      tokenNumber: 1,
      checkedInAt: now,
      consultationStartedAt: now,
      createdByUserId: doctor.id,
    },
  });
  await db.organisationSettings.create({
    data: { organisationId: org.id, chartModel: 'own_patients' },
  });
  return { patient, visitId: visit.id };
}

test.describe('referrals', () => {
  test('a doctor refers inside and outside the clinic; the receiver opens the chart, then closes it', async ({
    page,
    browser,
    clinic,
    db,
  }) => {
    // Set up both doctors first: an invite expects its membership still to be pending.
    await setUpFromInvite(page, clinic.inviteLink('doctor'), 'doctor synthetic passphrase');
    const secondLink = await inviteSecondDoctor(db, clinic);
    const context = await browser.newContext({ baseURL: WEB_URL });
    const second = await context.newPage();
    await setUpFromInvite(second, secondLink, 'second doctor synthetic passphrase');
    const { patient, visitId } = await visitInConsultation(db, clinic);

    // Under "own patients only" the second doctor cannot open the visit yet.
    await second.goto(`/clinic/consultations/${visitId}`);
    await expect(second.locator('main [role=alert]')).toContainText(
      'or who have an open referral for them',
    );

    // The visit's doctor refers the patient to the second doctor from the consultation.
    await page.getByRole('link', { name: 'Queue' }).click();
    await page
      .getByTestId(`appointment-${patient.uhid}`)
      .getByRole('link', { name: 'Consultation' })
      .click();
    const section = page.getByTestId('visit-referrals');
    await expect(section).toContainText('No referrals from this visit.');
    await section.getByRole('button', { name: 'Refer', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Refer Asha Verma' });
    await expect(dialog.getByLabel('A doctor in this clinic')).toBeChecked();
    // Nothing is sent without a doctor and a reason.
    await dialog.getByRole('button', { name: 'Send referral' }).click();
    await expect(dialog.getByText('Choose a doctor.')).toBeVisible();
    await expect(dialog.getByText('Enter the reason.')).toBeVisible();
    // A select's name includes its chosen option ("Doctor Choose a doctor").
    await dialog
      .getByRole('combobox', { name: /^Doctor\b/ })
      .selectOption({ label: 'Dr. Second Synthetic' });
    await dialog.getByLabel('Reason for referral').fill('Persistent knee effusion; arthroscopy?');
    await dialog.getByLabel('Urgency').selectOption({ label: 'Urgent' });
    await dialog.getByLabel('Notes (optional)', { exact: true }).fill('Aspirated once last month.');
    await dialog.getByRole('button', { name: 'Send referral' }).click();
    await expect(dialog).toBeHidden();
    await expect(section.getByRole('status')).toHaveText('Referral sent.');
    await expect(section).toContainText('To Dr. Second Synthetic');
    await expect(section.getByTestId('referral-status')).toHaveText('Sent');

    // And outside the clinic: a name, a specialty and a phone number.
    await section.getByRole('button', { name: 'Refer', exact: true }).click();
    await dialog.getByLabel('Someone outside the clinic').check();
    await dialog.getByLabel('Doctor or service name').fill('Dr Meera Iyer');
    await dialog.getByLabel('Specialty (optional)').fill('Cardiology');
    await dialog.getByLabel('Phone (optional)').fill('call me');
    await dialog.getByLabel('Reason for referral').fill('Cardiology opinion before surgery.');
    await dialog.getByRole('button', { name: 'Send referral' }).click();
    await expect(dialog.getByText('Enter a phone number of 6 to 20 digits.')).toBeVisible();
    await dialog.getByLabel('Phone (optional)').fill('+91 90000 00001');
    await dialog.getByRole('button', { name: 'Send referral' }).click();
    await expect(dialog).toBeHidden();
    await expect(section).toContainText('To Dr Meera Iyer, Cardiology');

    // The second doctor's dashboard counts the new referral.
    await second.goto('/clinic');
    await expect(second.getByTestId('referrals-new-count')).toHaveText('1 new');
    await second.getByRole('link', { name: 'Referrals', exact: true }).click();
    await expect(second.getByRole('tab', { name: 'Received' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    const received = second.getByTestId('referrals-received');
    await expect(received.getByTestId('referral-status')).toHaveText('Sent');
    await received.getByRole('link', { name: 'Open referral for Asha Verma' }).click();

    // Opening it marks it seen and shows the reason and notes.
    await expect(second.getByRole('heading', { name: 'Referral: Asha Verma' })).toBeVisible();
    await expect(second.getByTestId('referral-status')).toHaveText('Seen');
    await expect(second.getByTestId('referral-reason')).toHaveText(
      'Persistent knee effusion; arthroscopy?',
    );
    await expect(second.getByText('Aspirated once last month.')).toBeVisible();
    await expect(second.getByText(/While this referral is open you can read/)).toBeVisible();

    // The referral opens the chart and the visit (not theirs to write or refer from).
    await second.getByRole('link', { name: 'Open the visit' }).click();
    await expect(second.getByRole('heading', { name: 'Consultation: Asha Verma' })).toBeVisible();
    await expect(second.getByTestId('chart-allergies')).toBeVisible();
    await expect(
      second.getByTestId('visit-referrals').getByRole('button', { name: 'Refer', exact: true }),
    ).toHaveCount(0);

    // The receiver closes it with a note; the chart closes with it.
    await second.goBack();
    await second.getByLabel('Closing note (optional)').fill('Seen; arthroscopy planned.');
    await second.getByRole('button', { name: 'Close referral' }).click();
    await expect(second.locator('main').getByRole('status')).toHaveText('Referral closed.');
    await expect(second.getByTestId('referral-status')).toHaveText('Closed');
    await expect(second.getByTestId('referral-timeline')).toContainText('by Dr. Second Synthetic');
    await expect(second.getByRole('button', { name: 'Close referral' })).toHaveCount(0);
    await second.goto(`/clinic/consultations/${visitId}`);
    await expect(second.locator('main [role=alert]')).toContainText(
      'or who have an open referral for them',
    );
    await context.close();

    // The referring doctor sees both under Sent, one closed.
    await page.getByRole('link', { name: 'Referrals', exact: true }).click();
    await page.getByRole('tab', { name: 'Sent' }).click();
    const sent = page.getByTestId('referrals-sent');
    await expect(sent.getByRole('listitem')).toHaveCount(2);
    await expect(sent).toContainText('To Dr. Second Synthetic');
    await expect(sent).toContainText('To Dr Meera Iyer, Cardiology');
    await expect(sent.getByTestId('referral-status')).toHaveText(['Sent', 'Closed']);
  });

  test('the referring doctor previews and signs the letter; the receiver downloads it; its QR checks it', async ({
    page,
    browser,
    clinic,
    db,
  }) => {
    // Two doctors, a PDF preview, signing and the QR page: allow for slow CI runners.
    test.setTimeout(120_000);
    const password = 'doctor synthetic passphrase';
    const pin = '482916';
    await setUpFromInvite(page, clinic.inviteLink('doctor'), password);
    const secondLink = await inviteSecondDoctor(db, clinic);
    const context = await browser.newContext({ baseURL: WEB_URL });
    const second = await context.newPage();
    await setUpFromInvite(second, secondLink, 'second doctor synthetic passphrase');
    const { patient, visitId } = await visitInConsultation(db, clinic);
    await setUpPrescriptionPad(page, db, clinic, { prefix: 'SD', password, pin });

    // A referral to the second doctor (the dialog is covered above).
    const visit = await db.appointment.findUniqueOrThrow({ where: { id: visitId } });
    const receiver = await db.user.findUniqueOrThrow({
      where: { email: `second-doctor@${clinic.slug}.test` },
    });
    const referral = await db.referral.create({
      data: {
        organisationId: visit.organisationId,
        appointmentId: visitId,
        patientId: patient.id,
        referringDoctorUserId: visit.doctorUserId,
        kind: 'internal',
        receivingDoctorUserId: receiver.id,
        reason: 'Persistent knee effusion; arthroscopy?',
        urgency: 'urgent',
        sentAt: new Date(),
      },
    });

    // The receiver sees that no letter is signed yet, and cannot sign one.
    await second.goto(`/clinic/referrals/${referral.id}`);
    const theirs = second.getByTestId('referral-letter');
    await expect(theirs).toContainText('The referring doctor has not signed a letter.');
    await expect(theirs.getByRole('button', { name: 'Sign letter' })).toHaveCount(0);

    // The referring doctor previews the letter (a PDF in a new tab), then signs it.
    await page.goto(`/clinic/referrals/${referral.id}`);
    const card = page.getByTestId('referral-letter');
    await expect(card).toContainText('No letter yet.');
    const preview = page.waitForResponse(
      (r) =>
        r.request().method() === 'GET' &&
        /\/referrals\/[^/]+\/letter\/preview$/.test(new URL(r.url()).pathname),
    );
    const previewTab = page.waitForEvent('popup');
    await card.getByRole('button', { name: 'Preview letter' }).click();
    const previewed = await preview;
    expect(previewed.status()).toBe(200);
    expect(previewed.headers()['content-type']).toBe('application/pdf');
    await (await previewTab).close();

    await card.getByLabel('Letter language').selectOption({ label: 'English' });
    await card.getByRole('button', { name: 'Sign letter' }).click();
    await expect(card).toContainText('Once signed, the letter cannot change.');
    await card.getByLabel('Signing PIN').fill('000000');
    await card.getByRole('button', { name: 'Sign now' }).click();
    await expect(card.getByRole('alert')).toHaveText('That PIN is not right.');
    await card.getByLabel('Signing PIN').fill(pin);
    await card.getByRole('button', { name: 'Sign now' }).click();
    await expect(card.getByRole('status')).toHaveText('Letter signed.');
    await expect(card.getByTestId('referral-letter-signed')).toContainText('English');
    await expect(card.getByRole('button', { name: 'Sign letter' })).toHaveCount(0);
    await expect(card).toContainText('Test signature: not legally valid');

    // Download: the signed letter, with the recipient and the reason.
    const download = page.waitForResponse(
      (r) =>
        r.request().method() === 'GET' &&
        /\/referrals\/[^/]+\/letter$/.test(new URL(r.url()).pathname),
    );
    const downloadTab = page.waitForEvent('popup');
    await card.getByRole('button', { name: 'Download letter' }).click();
    const file = await download;
    expect(file.status()).toBe(200);
    expect(file.headers()['content-type']).toBe('application/pdf');
    // The browser's copy is a blob; check the stored file, against its recorded hash.
    const letter = await db.referralLetter.findUniqueOrThrow({
      where: { referralId: referral.id },
    });
    const stored = await readFile(join(E2E_FILE_STORE_DIR, letter.pdfFileKey));
    expect(createHash('sha256').update(stored).digest('hex')).toBe(letter.pdfSha256);
    const text = pdfText(stored);
    expect(text).toContain('To: Dr. Second Synthetic');
    expect(text).toContain('Persistent knee effusion; arthroscopy?');
    expect(text).toContain('Urgency: Urgent');
    await (await downloadTab).close();

    // The receiver downloads it too, and it stays valid after they close the referral.
    await second.reload();
    await expect(theirs.getByTestId('referral-letter-signed')).toBeVisible();
    await second.getByRole('button', { name: 'Close referral' }).click();
    await expect(second.locator('main').getByRole('status')).toHaveText('Referral closed.');
    await expect(theirs).toContainText('The referral is closed; the signed letter stays valid.');
    const theirDownload = second.waitForResponse(
      (r) =>
        r.request().method() === 'GET' &&
        /\/referrals\/[^/]+\/letter$/.test(new URL(r.url()).pathname),
    );
    const theirTab = second.waitForEvent('popup');
    await theirs.getByRole('button', { name: 'Download letter' }).click();
    expect((await theirDownload).status()).toBe(200);
    await (await theirTab).close();
    await context.close();

    // The QR page checks it: genuine, with the patient's initials only.
    const qr = await page.context().newPage();
    await qr.goto(`/verify/referral/${letter.verificationCode}`);
    await expect(qr.getByRole('heading', { name: 'Referral letter check' })).toBeVisible();
    await expect(qr.getByTestId('verify-status')).toHaveText('Genuine');
    const result = qr.getByTestId('verify-result');
    await expect(result).toContainText('Dr. Second Synthetic');
    await expect(result).toContainText('Urgent');
    await expect(result).not.toContainText(patient.name);
    await expect(result).not.toContainText('knee effusion');
    // A prescription's QR page does not know a letter's code.
    await qr.goto(`/verify/${letter.verificationCode}`);
    await expect(qr.getByTestId('verify-result').getByRole('alert')).toContainText(
      'No prescription matches this code.',
    );

    // A referral closed elsewhere while its page is open: signing is refused, and the card
    // shows the referral as it now is.
    const later = await db.referral.create({
      data: {
        organisationId: visit.organisationId,
        appointmentId: visitId,
        patientId: patient.id,
        referringDoctorUserId: visit.doctorUserId,
        kind: 'external',
        externalName: 'Dr Meera Iyer',
        reason: 'Cardiology opinion before surgery.',
        urgency: 'routine',
        sentAt: new Date(),
      },
    });
    await page.goto(`/clinic/referrals/${later.id}`);
    await card.getByRole('button', { name: 'Sign letter' }).click();
    const closedAt = new Date();
    await db.referral.update({
      where: { id: later.id },
      data: { status: 'closed', closedAt, closedByUserId: visit.doctorUserId },
    });
    await card.getByLabel('Signing PIN').fill(pin);
    await card.getByRole('button', { name: 'Sign now' }).click();
    await expect(page.locator('main').getByRole('alert')).toHaveText(
      'This referral is closed; a letter can no longer be signed.',
    );
    await expect(card).toContainText('No letter was signed before the referral was closed.');
    await expect(card.getByRole('button', { name: 'Sign now' })).toHaveCount(0);
    await expect(page.getByTestId('referral-status')).toHaveText('Closed');
  });
});
