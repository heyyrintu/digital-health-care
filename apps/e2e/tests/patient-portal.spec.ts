import type { Db } from '@dhc/db';
import type { Page } from '@playwright/test';
import {
  expect,
  setUpFromInvite,
  setUpPrescriptionPad,
  signInAsPatient,
  syntheticMobile,
  test,
  type Clinic,
} from '../fixtures';

/** A clinic, a 20-minute schedule 09:00–10:00 every day, and an active doctor. */
async function schedule(db: Db, clinic: Clinic) {
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
      defaultDurationMin: 20,
      feePaise: 80000,
    },
  });
  const hours = [{ start: '09:00', end: '10:00' }];
  await db.availabilityVersion.create({
    data: {
      organisationId: org.id,
      doctorUserId: doctor.id,
      clinicId: place.id,
      consultationTypeId: type.id,
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
      weekly: {
        mon: hours,
        tue: hours,
        wed: hours,
        thu: hours,
        fri: hours,
        sat: hours,
        sun: hours,
      },
      slotMinutes: 20,
      createdByUserId: doctor.id,
    },
  });
  return { org, doctor, place, type };
}

/**
 * The address the portal sends its next new tab to. Headless Chromium saves a PDF instead of
 * showing it, so the tab may stay blank and download the address instead: either counts.
 */
function nextTabAddress(page: Page): Promise<string> {
  return new Promise((resolve) => {
    page.once('popup', (tab) => {
      tab.once('download', (d) => resolve(d.url()));
      tab.on('framenavigated', (f) => {
        if (f === tab.mainFrame() && f.url() !== 'about:blank') resolve(f.url());
      });
    });
  });
}

// Phone first: the portal must work in mobile browsers (Build Plan §5.1).
test.use({ viewport: { width: 390, height: 844 } });

test.describe('patient portal', () => {
  test('Pooja Singh signs in by SMS code, accepts the consents, adds Aarav, books, cancels and withdraws consent', async ({
    page,
    clinic,
    db,
  }) => {
    const { org } = await schedule(db, clinic);
    // Synthetic persona (docs/qa/test-plan.md §3): the clinic registered Pooja on her number.
    const phone = syntheticMobile();
    await db.patient.create({
      data: {
        organisationId: org.id,
        uhid: 'E2E-000101',
        name: 'Pooja Singh',
        phone: `+91${phone}`,
        dob: new Date('1992-03-14T00:00:00Z'),
        gender: 'female',
      },
    });

    // Signed out, the portal sends the patient to its own sign-in page.
    await page.goto('/app');
    await expect(page).toHaveURL(/\/app\/login$/);

    // A number that is not an Indian mobile is refused before any code is sent.
    await page.goto(`/app/login?clinic=${clinic.slug}`);
    await page.getByLabel('Mobile number').fill('12345');
    await page.getByRole('button', { name: 'Send code' }).click();
    await expect(page.locator('main [role=alert]')).toContainText('10-digit Indian mobile');

    await signInAsPatient(page, db, clinic, phone);

    // Consents come before anything else.
    await expect(page.getByRole('heading', { name: 'Before you start' })).toBeVisible();
    await expect(page.getByRole('navigation')).toHaveCount(0);
    await page.getByRole('button', { name: 'Accept and continue' }).click();
    await expect(page.locator('main [role=alert]')).toHaveText('Tick each one to continue.');
    await page.getByRole('checkbox', { name: 'I have read the privacy notice' }).check();
    await page.getByRole('checkbox', { name: 'I accept the terms of use' }).check();
    await page.getByRole('checkbox', { name: /health records/i }).check();
    await page.getByRole('button', { name: 'Accept and continue' }).click();

    // Home: Pooja's own record, found by her number.
    await expect(page.getByRole('heading', { name: 'Welcome, Pooja Singh' })).toBeVisible();
    await expect(page.getByTestId('signed-in-as')).toContainText(phone);
    await expect(page.getByTestId('next-appointment')).toContainText('No upcoming appointments.');

    // The refresh token is in the portal's own httpOnly cookie; nothing is in storage.
    const cookies = await page.context().cookies();
    const session = cookies.find((c) => c.name === 'dhc_patient_session');
    expect(session).toMatchObject({ httpOnly: true, path: '/api/patient-session' });
    // Not kept on this device: the cookie goes when the browser closes.
    expect(session?.expires).toBe(-1);
    expect(cookies.some((c) => c.name === 'dhc_session')).toBe(false);
    const stored = await page.evaluate(() => Object.keys(window.localStorage));
    expect(
      stored.every((k) =>
        ['dhc.patientClinic', 'dhc.patientLocale', 'dhc.patientActivity'].includes(k),
      ),
    ).toBe(true);

    // Hindi, then back.
    await page.getByRole('button', { name: 'हिंदी' }).click();
    await expect(page.getByRole('heading', { name: 'स्वागत है, Pooja Singh' })).toBeVisible();
    await page.getByRole('button', { name: 'English' }).click();

    // Family: add Aarav (6), looked after by Pooja.
    await page.getByRole('navigation').getByRole('link', { name: 'Family' }).click();
    await expect(page.getByRole('heading', { name: 'Family', level: 1 })).toBeVisible();
    await page.getByLabel('Full name').fill('Aarav Singh');
    await page.getByLabel('Date of birth').fill('2020-06-01');
    await page.getByRole('button', { name: 'Male', exact: true }).click();
    await page.getByRole('button', { name: 'Add a family member' }).click();
    // A child needs the adult who looks after them.
    await expect(page.locator('main [role=alert]')).toContainText('under 18');
    await page
      .getByRole('group', { name: 'Who looks after them' })
      .getByRole('button', { name: 'Pooja Singh' })
      .click();
    await page.getByRole('button', { name: 'Add a family member' }).click();
    await expect(page.getByRole('status')).toHaveText('Aarav Singh has been added.');
    const aarav = page.getByTestId('family-member').filter({ hasText: 'Aarav Singh' });
    await expect(aarav).toContainText('Looked after by Pooja Singh');
    await expect(page.getByLabel('Full name')).toHaveValue('');

    // Book for Aarav: tomorrow at 09:20.
    await page.getByRole('navigation').getByRole('link', { name: 'Book appointment' }).click();
    await page
      .getByRole('group', { name: 'For' })
      .getByRole('button', { name: 'Aarav Singh' })
      .click();
    await page.getByRole('group', { name: 'Date' }).getByRole('button').nth(1).click();
    await page.locator('[data-slot="09:20"]').click();
    await page.getByLabel('Reason for visit (optional)').fill('Fever for two days');
    await expect(page.getByText('Fee ₹800, paid at the clinic.')).toBeVisible();
    await page.getByRole('button', { name: /^Book 09:20/ }).click();
    await expect(page.getByRole('status')).toContainText(
      /Booked for .* at 09:20\. Your token is \d+\./,
    );

    // Appointments: upcoming, then cancelled after confirming.
    await page.getByRole('link', { name: 'Appointments' }).first().click();
    const upcoming = page.getByTestId('upcoming').getByTestId('appointment');
    await expect(upcoming).toHaveCount(1);
    await expect(upcoming).toContainText('Aarav Singh');
    await expect(upcoming).toContainText('09:20 · Booked');
    await upcoming.getByRole('button', { name: 'Cancel appointment' }).click();
    await expect(upcoming.getByText('Cancel this appointment?')).toBeVisible();
    await upcoming.getByRole('button', { name: 'Cancel appointment' }).click();
    await expect(page.getByRole('status')).toHaveText('Appointment cancelled.');
    await expect(page.getByTestId('upcoming')).toHaveCount(0);
    await expect(page.getByTestId('past').getByTestId('appointment')).toContainText(
      '09:20 · Cancelled',
    );

    // Booked by the patient, cancelled by the patient, and every step audited by the API.
    const booked = await db.appointment.findFirstOrThrow({
      where: { organisationId: org.id, patient: { name: 'Aarav Singh' } },
    });
    expect(booked).toMatchObject({ status: 'cancelled', reason: 'Fever for two days' });

    // Privacy: what was accepted, and withdrawing the health-data consent, which closes the
    // health records until it is accepted again.
    await page.getByRole('navigation').getByRole('link', { name: 'Home' }).click();
    await page.getByRole('link', { name: 'Privacy and consents' }).click();
    const healthData = page.getByTestId('consent').filter({ hasText: 'Health-data consent' });
    await expect(healthData).toContainText('Accepted');
    await healthData.getByRole('button', { name: 'Withdraw health-data consent' }).click();
    await expect(healthData).toContainText('The portal and the app will stop showing');
    await healthData.getByRole('button', { name: 'Withdraw health-data consent' }).click();
    await expect(page.getByRole('heading', { name: 'Before you start' })).toBeVisible();
    await expect(page.getByText('Some documents have changed')).toBeVisible();
    await page.getByRole('checkbox', { name: /health records/i }).check();
    await page.getByRole('button', { name: 'Accept and continue' }).click();
    await expect(page.getByRole('heading', { name: 'Privacy and consents' })).toBeVisible();

    // A reload keeps the session (the cookie and recent activity).
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Privacy and consents' })).toBeVisible();

    // Back after 15 minutes without use in any tab: the session is ended, not restored.
    await page.evaluate(() =>
      window.localStorage.setItem('dhc.patientActivity', String(Date.now() - 16 * 60_000)),
    );
    await page.reload();
    await expect(page).toHaveURL(/\/app\/login$/);
    await expect(page.getByRole('status')).toContainText('15 minutes');
    await expect
      .poll(async () =>
        (await page.context().cookies()).some((c) => c.name === 'dhc_patient_session'),
      )
      .toBe(false);

    // Kept on this device: a 30-day cookie. Signing out ends it, and the pages are protected.
    await signInAsPatient(page, db, clinic, phone, { keep: true });
    await expect(page.getByRole('heading', { name: 'Welcome, Pooja Singh' })).toBeVisible();
    const kept = (await page.context().cookies()).find((c) => c.name === 'dhc_patient_session');
    expect(kept!.expires * 1000 - Date.now()).toBeGreaterThan(29 * 24 * 3600_000);
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/app\/login$/);
    // The sign-out request clears the cookie as it finishes, a moment after the page moves on.
    await expect
      .poll(async () =>
        (await page.context().cookies()).some((c) => c.name.startsWith('dhc_patient')),
      )
      .toBe(false);
    await page.goto('/app/family');
    await expect(page).toHaveURL(/\/app\/login$/);

    const actions = (
      await db.auditLog.findMany({ where: { organisationId: org.id }, select: { action: true } })
    ).map((a) => a.action);
    for (const action of [
      'auth.otp.requested',
      'auth.otp.verified',
      'auth.session.created',
      'consent.accepted',
      'consent.withdrawn',
      'patient.created',
      'appointment.created',
      'appointment.status_changed',
      'auth.logout',
    ]) {
      expect(actions, action).toContain(action);
    }

    // The staff dashboard never sees the patient's session.
    await page.goto('/clinic');
    await expect(page).toHaveURL(/\/clinic\/login$/);
  });

  test('Pooja Singh opens her signed prescription and uploads the MRI report her doctor ordered', async ({
    page,
    browser,
    clinic,
    db,
  }) => {
    // The doctor works in their own browser first: allow for slow CI runners.
    test.setTimeout(120_000);
    // The doctor accepts the invite first (it is for an invited, not yet active, member).
    const desk = await (
      await browser.newContext({ baseURL: test.info().project.use.baseURL })
    ).newPage();
    const password = 'doctor synthetic passphrase';
    const pin = '482916';
    try {
      await setUpFromInvite(desk, clinic.inviteLink('doctor'), password);
    } catch (e) {
      await desk.context().close();
      throw e;
    }
    const { org, doctor, place, type } = await schedule(db, clinic);
    const phone = syntheticMobile();
    const pooja = await db.patient.create({
      data: {
        organisationId: org.id,
        uhid: 'E2E-000101',
        name: 'Pooja Singh',
        phone: `+91${phone}`,
        dob: new Date('1992-03-14T00:00:00Z'),
        gender: 'female',
      },
    });
    // Pooja is with the doctor today.
    const startAt = new Date();
    const visit = await db.appointment.create({
      data: {
        organisationId: org.id,
        patientId: pooja.id,
        doctorUserId: doctor.id,
        clinicId: place.id,
        consultationTypeId: type.id,
        date: new Date(
          `${new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10)}T00:00:00Z`,
        ),
        startAt,
        endAt: new Date(startAt.getTime() + 20 * 60_000),
        status: 'in_consultation',
        source: 'walk_in',
        tokenNumber: 1,
        checkedInAt: startAt,
        consultationStartedAt: startAt,
        createdByUserId: doctor.id,
      },
    });

    // The doctor orders an MRI knee, right and signs with the PIN.
    try {
      await setUpPrescriptionPad(desk, db, clinic, { prefix: 'PS', password, pin });
      await desk.goto(`/clinic/consultations/${visit.id}`);
      const rx = desk.getByTestId('prescription');
      const tests = rx.getByTestId('tests-section');
      await tests.getByLabel('Add test: search blood tests, X-ray, MRI, CT').fill('mri');
      await tests
        .getByTestId('tests-matches')
        .getByRole('button', { name: 'MRI', exact: true })
        .click();
      const picker = tests.getByTestId('test-picker');
      await picker.getByLabel('Region').selectOption('Knee');
      await picker.getByLabel('Side').selectOption('right');
      await picker.getByRole('button', { name: 'Add test' }).click();
      await expect(rx.getByTestId('rx-save-status')).toHaveText('Saved');
      const panel = rx.getByTestId('sign-panel');
      await panel.getByRole('button', { name: 'Sign prescription' }).click();
      await panel.getByLabel('Signing PIN').fill(pin);
      await panel.getByRole('button', { name: 'Sign now' }).click();
      await expect(panel).toContainText('Rx PS-00001, version 1');
    } finally {
      await desk.context().close();
    }

    // Pooja signs in on the portal and accepts the consents.
    await signInAsPatient(page, db, clinic, phone);
    await page.getByRole('checkbox', { name: 'I have read the privacy notice' }).check();
    await page.getByRole('checkbox', { name: 'I accept the terms of use' }).check();
    await page.getByRole('checkbox', { name: /health records/i }).check();
    await page.getByRole('button', { name: 'Accept and continue' }).click();
    await expect(page.getByRole('heading', { name: 'Welcome, Pooja Singh' })).toBeVisible();

    // Prescriptions, from Home: whose, the doctor, the visit and when it was signed.
    await page.getByRole('main').getByRole('link', { name: 'Prescriptions' }).click();
    await expect(page.getByRole('heading', { name: 'Prescriptions', level: 1 })).toBeVisible();
    const card = page.getByTestId('prescription');
    await expect(card).toHaveCount(1);
    await expect(card).toContainText('Pooja Singh');
    await expect(card).toContainText('PS-00001 · Version 1');
    await expect(card).toContainText('Dr. Synthetic');
    await expect(card.getByTestId('prescription-signed')).toHaveText(/^Signed \S+, \d{1,2} \S+$/);

    // The PDF comes from the API with the bearer token in the header, never in the address,
    // and opens in a new tab from an object URL.
    const pdf = page.waitForResponse(
      (r) => r.request().method() === 'GET' && /\/portal\/prescriptions\/[^/]+\/pdf$/.test(r.url()),
    );
    const tab = page.waitForEvent('popup');
    const address = nextTabAddress(page);
    await card.getByRole('button', { name: 'Open PDF' }).click();
    const response = await pdf;
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toBe('application/pdf');
    expect(response.request().headers()['authorization']).toMatch(/^Bearer /);
    expect(response.url()).not.toMatch(/token|bearer/i);
    expect(await address).toMatch(/^blob:http:\/\/localhost:3300\/[0-9a-f-]+$/);
    await (await tab).close();

    // Download saves it under the prescription's number and version.
    const download = page.waitForEvent('download');
    await card.getByRole('button', { name: 'Download PDF' }).click();
    expect((await download).suggestedFilename()).toBe('PS-00001-v1.pdf');

    // Tests: the MRI the doctor ordered, how it prints, in English and Hindi.
    await page.getByRole('navigation').getByRole('link', { name: 'Tests' }).click();
    await expect(page.getByRole('heading', { name: 'Tests', level: 1 })).toBeVisible();
    const mri = page.getByTestId('test-order');
    await expect(mri).toHaveCount(1);
    await expect(mri).toContainText('MRI knee, right');
    await expect(mri).toContainText('Dr. Synthetic');
    await expect(mri.getByTestId('test-order-status')).toHaveText('Ordered');
    await expect(page.getByText('up to 25 MB')).toBeVisible();
    await page.getByRole('button', { name: 'हिंदी' }).click();
    await expect(mri).toContainText('MRI knee, दायाँ');
    await expect(mri.getByTestId('test-order-status')).toHaveText('लिखी गई');
    await page.getByRole('button', { name: 'English' }).click();

    // A GIF is refused before anything is sent. The button opens the browser's file chooser.
    const upload = mri.getByRole('button', { name: 'Upload result for MRI knee, right' });
    const choose = async (file: { name: string; mimeType: string; buffer: Buffer }) => {
      const chooser = page.waitForEvent('filechooser');
      await upload.click();
      await (await chooser).setFiles(file);
    };
    await choose({
      name: 'scan.gif',
      mimeType: 'image/gif',
      buffer: Buffer.from('GIF89a synthetic'),
    });
    await expect(mri.getByRole('alert')).toHaveText(
      'Choose a PDF or a photo (JPEG, PNG, HEIC or HEIF).',
    );

    // A small synthetic PDF report is uploaded.
    const sent = page.waitForResponse(
      (r) =>
        r.request().method() === 'POST' && /\/portal\/test-orders\/[^/]+\/results$/.test(r.url()),
    );
    await choose({
      name: 'mri-report.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.7\n% synthetic MRI report\n'),
    });
    expect((await sent).status()).toBe(201);
    await expect(mri.getByRole('status')).toHaveText(
      'Result uploaded. The doctor will see it to review.',
    );
    await expect(mri.getByTestId('test-order-status')).toHaveText('Result uploaded');
    await expect(mri.getByTestId('test-result')).toContainText('PDF · 1 KB · sent by you');

    // The report opens like the prescription.
    const file = page.waitForResponse(
      (r) => r.request().method() === 'GET' && /\/portal\/test-results\/[^/]+\/file$/.test(r.url()),
    );
    const resultTab = page.waitForEvent('popup');
    await mri.getByRole('button', { name: 'View result 1 for MRI knee, right' }).click();
    const fileResponse = await file;
    expect(fileResponse.status()).toBe(200);
    expect(fileResponse.headers()['content-type']).toBe('application/pdf');
    await (await resultTab).close();

    // Still there after a reload.
    await page.reload();
    await expect(page.getByTestId('test-order').getByTestId('test-order-status')).toHaveText(
      'Result uploaded',
    );

    // With pop-ups blocked (a second browser), nothing downloads unasked: the page offers a
    // link, and the PDF downloads when Pooja clicks it.
    const blocked = await browser.newContext({ baseURL: test.info().project.use.baseURL });
    try {
      await blocked.addInitScript(() => {
        window.open = () => null;
      });
      const other = await blocked.newPage();
      await signInAsPatient(other, db, clinic, phone);
      await expect(other.getByRole('heading', { name: 'Welcome, Pooja Singh' })).toBeVisible();
      await other.goto('/app/prescriptions');
      const otherCard = other.getByTestId('prescription');
      const unasked: unknown[] = [];
      other.on('download', (d) => unasked.push(d));
      await otherCard.getByRole('button', { name: 'Open PDF' }).click();
      const fallback = otherCard.getByRole('link', {
        name: 'Your browser blocked the new tab. Download the file instead.',
      });
      await expect(fallback).toBeVisible();
      await expect(fallback).toHaveAttribute('href', /^blob:/);
      expect(unasked).toHaveLength(0);
      const saved = other.waitForEvent('download');
      await fallback.click();
      expect((await saved).suggestedFilename()).toBe('PS-00001-v1.pdf');
    } finally {
      await blocked.close();
    }

    // Signing out closes the tabs the portal opened.
    const lastTab = page.waitForEvent('popup');
    await page
      .getByTestId('test-order')
      .getByRole('button', { name: 'View result 1 for MRI knee, right' })
      .click();
    const left = await lastTab;
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/app\/login$/);
    await expect.poll(() => left.isClosed()).toBe(true);

    // The API audited the PDF view, the upload and the result view, as the patient.
    const patientUser = await db.user.findUniqueOrThrow({ where: { phone: `+91${phone}` } });
    const order = await db.testOrder.findFirstOrThrow({ where: { organisationId: org.id } });
    const audited = await db.auditLog.findMany({
      where: { organisationId: org.id, actorUserId: patientUser.id },
      select: { action: true, entityId: true },
    });
    const prescription = await db.prescription.findFirstOrThrow({
      where: { appointmentId: visit.id },
    });
    expect(audited).toContainEqual({
      action: 'prescription.pdf_viewed',
      entityId: prescription.id,
    });
    expect(audited).toContainEqual({ action: 'test_order.result_uploaded', entityId: order.id });
    expect(audited).toContainEqual({ action: 'test_result.viewed', entityId: order.id });
    expect(order.status).toBe('result_uploaded');
  });
});
