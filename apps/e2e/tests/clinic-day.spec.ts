import type { Browser, Page } from '@playwright/test';
import { expect, setUpFromInvite, test, type Clinic } from '../fixtures';
import type { Db } from '@dhc/db';

/**
 * The Phase 1 exit check (build plan §9.1): a full simulated clinic day on the web, with
 * the front desk, the doctor and the clinic admin each in their own browser.
 */

const WEB_URL = 'http://localhost:3300';
const DOCTOR_PASSWORD = 'doctor synthetic passphrase';
const PIN = '271828';

const istDay = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

async function signedIn(browser: Browser, link: string, password: string): Promise<Page> {
  const context = await browser.newContext({ baseURL: WEB_URL });
  const page = await context.newPage();
  await setUpFromInvite(page, link, password);
  return page;
}

/**
 * The clinic's set-up, done before the day starts: a clinic, a consultation at ₹800, the
 * doctor's hours all day, and two bookings for earlier today (Ravi, who has arrived, and
 * Kamla, who has not). The seeded patients were registered long ago.
 */
async function openClinic(db: Db, clinic: Clinic) {
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
  const hours = [{ start: '00:00', end: '23:45' }];
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
      slotMinutes: 15,
      createdByUserId: doctor.id,
    },
  });
  await db.patient.updateMany({
    where: { organisationId: org.id },
    data: { createdAt: new Date('2026-01-01T06:00:00Z') },
  });
  const [, ravi, kamla] = await db.patient.findMany({
    where: { organisationId: org.id },
    orderBy: { uhid: 'asc' },
  });
  // Booked a minute ago, so the slot has started (a no-show can only be marked after it).
  const startAt = new Date(Date.now() - 60_000);
  for (const [i, patient] of [ravi!, kamla!].entries()) {
    await db.appointment.create({
      data: {
        organisationId: org.id,
        patientId: patient.id,
        doctorUserId: doctor.id,
        clinicId: place.id,
        consultationTypeId: type.id,
        date: new Date(`${istDay()}T00:00:00Z`),
        startAt,
        endAt: new Date(startAt.getTime() + 15 * 60_000),
        status: 'confirmed',
        source: 'front_desk',
        tokenNumber: i + 1,
        createdByUserId: doctor.id,
      },
    });
  }
  return { org, doctor };
}

test.describe('a clinic day', () => {
  test('registration to collections, across front desk, doctor and clinic admin', async ({
    browser,
    clinic,
    db,
  }) => {
    test.setTimeout(180_000);

    // Morning: everyone signs in (the invites expect their memberships still pending).
    const desk = await signedIn(
      browser,
      clinic.inviteLink('front_desk'),
      'desk synthetic passphrase',
    );
    const doctorPage = await signedIn(browser, clinic.inviteLink('doctor'), DOCTOR_PASSWORD);
    const admin = await signedIn(
      browser,
      clinic.inviteLink('clinic_admin'),
      'admin synthetic passphrase',
    );
    const { org, doctor } = await openClinic(db, clinic);

    // The doctor's prescription pad and signing PIN; the platform team verifies them.
    await doctorPage.goto('/clinic/profile');
    const pad = doctorPage.getByTestId('profile-form');
    await pad.getByLabel('Registration number').fill('TEST-24680');
    await pad.getByLabel('Medical council').fill('Test Medical Council');
    await pad.getByLabel('Qualifications').fill('MBBS, MS (Ortho)');
    await pad.getByLabel('Prescription number prefix').fill('DAY');
    await pad.getByRole('button', { name: 'Save' }).click();
    await expect(pad.getByRole('status')).toHaveText('Saved.');
    const pinForm = doctorPage.getByTestId('pin-form');
    await pinForm.getByLabel('Account password').fill(DOCTOR_PASSWORD);
    await pinForm.getByLabel('New PIN').fill(PIN);
    await pinForm.getByLabel('Repeat the PIN').fill(PIN);
    await pinForm.getByRole('button', { name: 'Save PIN' }).click();
    await expect(pinForm.getByRole('status')).toHaveText('PIN saved.');
    await db.doctorProfile.update({
      where: { organisationId_userId: { organisationId: org.id, userId: doctor.id } },
      data: { verification: 'verified', verifiedAt: new Date(), verifiedBy: 'e2e (SUP-1)' },
    });

    // Front desk: a new patient walks in, is registered and joins today's queue.
    await desk.getByRole('link', { name: 'Register patient' }).click();
    await desk.getByLabel('Name', { exact: true }).fill('Neha Sharma');
    await desk.getByLabel('Mobile', { exact: true }).fill('98110 22334');
    await desk.getByLabel('Date of birth').fill('1990-04-12');
    await desk.getByLabel('Gender').selectOption('female');
    await desk.getByRole('button', { name: 'Register', exact: true }).click();
    await expect(desk.getByTestId('patient-uhid')).toHaveText('10001');

    await desk.goto('/clinic/queue');
    await desk.getByRole('link', { name: 'Add walk-in' }).click();
    await desk.getByPlaceholder('Find patient by name, mobile or UHID').fill('Neha');
    await desk.getByRole('button', { name: 'Search' }).click();
    await desk.getByRole('button', { name: 'Choose' }).click();
    await desk.getByRole('button', { name: 'Add as walk-in today' }).click();
    const neha = desk.getByTestId('appointment-10001');
    await expect(neha.getByTestId('appointment-status')).toHaveText('Checked in');

    // Ravi arrives for his booking; Kamla does not come.
    await desk.getByRole('tab', { name: /Booked/ }).click();
    await desk
      .getByTestId('appointment-E2E-000002')
      .getByRole('button', { name: 'Check in' })
      .click();
    await desk
      .getByTestId('appointment-E2E-000003')
      .getByRole('button', { name: 'Mark no-show' })
      .click();
    await desk.getByRole('tab', { name: /My OPD/ }).click();
    await expect(
      desk.getByTestId('appointment-E2E-000002').getByTestId('appointment-status'),
    ).toHaveText('Checked in');

    // Front desk takes Neha's vitals.
    await neha.getByRole('link', { name: 'Vitals' }).click();
    await desk.getByLabel('Weight (kg)').fill('58');
    await desk.getByLabel('Height (cm)').fill('162');
    await desk.getByLabel('BP systolic (mmHg)').fill('118');
    await desk.getByRole('button', { name: 'Save vitals' }).click();
    await expect(desk.getByText('Vitals saved')).toBeVisible();

    // Doctor: sees Neha, writes notes and a prescription, signs it and completes the visit.
    await doctorPage.goto('/clinic/queue');
    const nehaForDoctor = doctorPage.getByTestId('appointment-10001');
    await nehaForDoctor.getByRole('button', { name: 'Start consultation' }).click();
    await expect(nehaForDoctor.getByTestId('appointment-status')).toHaveText('In consultation');
    await nehaForDoctor.getByRole('link', { name: 'Consultation' }).click();
    await expect(
      doctorPage.getByRole('heading', { name: 'Consultation: Neha Sharma' }),
    ).toBeVisible();
    await expect(doctorPage.getByLabel('Weight (kg)')).toHaveValue('58');
    await doctorPage.getByLabel('Chief complaint').fill('Low back pain for a week');
    await doctorPage.getByRole('textbox', { name: 'Diagnosis' }).fill('Mechanical low back pain');
    await doctorPage.getByRole('textbox', { name: 'Diagnosis' }).press('Enter');
    await doctorPage.getByLabel('Plan', { exact: true }).fill('Rest, posture advice');
    await expect(doctorPage.getByTestId('save-status')).toContainText('Saved');

    const rx = doctorPage.getByTestId('prescription');
    await rx.getByLabel('Add medicine: search name or composition').fill('parace');
    await rx.getByRole('option', { name: /^Paracetamol 500/ }).click();
    await rx.getByTestId('rx-line-0').getByLabel('Frequency').fill('1-0-1');
    await expect(rx.getByTestId('rx-save-status')).toHaveText('Saved');
    const panel = rx.getByTestId('sign-panel');
    await panel.getByRole('button', { name: 'Sign prescription' }).click();
    await panel.getByLabel('Signing PIN').fill(PIN);
    await panel.getByRole('button', { name: 'Sign now' }).click();
    await expect(panel).toContainText('Rx DAY-00001, version 1');

    await doctorPage.goto('/clinic/queue');
    await doctorPage
      .getByTestId('appointment-10001')
      .getByRole('button', { name: 'Complete' })
      .click();
    await expect(doctorPage.getByTestId('appointment-10001')).toHaveCount(0);

    // Front desk: bills Neha and takes cash; the receipt is ready to print.
    await desk.goto('/clinic/queue');
    await desk.getByRole('tab', { name: /Completed/ }).click();
    await desk.getByTestId('appointment-10001').getByRole('link', { name: 'Bill' }).click();
    await expect(desk.getByRole('heading', { name: 'Bill for Neha Sharma' })).toBeVisible();
    await desk.getByRole('button', { name: 'Save bill' }).click();
    await expect(desk.getByRole('status')).toContainText('Bill saved.');
    await expect(desk.getByLabel('Amount (₹)')).toHaveValue('800');
    await desk.getByRole('button', { name: 'Record payment' }).click();
    await expect(desk.getByTestId('bill-status')).toContainText('Paid');
    await desk.getByRole('link', { name: 'Receipt R00001' }).click();
    await expect(desk.getByTestId('receipt')).toContainText('10001');
    await expect(desk.getByRole('button', { name: 'Print receipt' })).toBeVisible();

    // Clinic admin: the day's figures, collections and the audit trail.
    await admin.reload();
    const figures = admin.getByTestId('clinic-figures');
    await figures.getByRole('button', { name: 'Today' }).click();
    const tile = (label: string | RegExp) => figures.locator('.surface').filter({ hasText: label });
    await expect(tile('Appointments')).toContainText('3');
    await expect(tile(/^1\s*Completed$/)).toBeVisible();
    await expect(tile('No-shows (50%)')).toContainText('1');
    await expect(tile('New patients')).toContainText('1');
    await expect(tile('Prescriptions signed')).toContainText('1');
    await expect(tile('Collected')).toContainText('₹800');

    await admin.getByRole('link', { name: 'Collections' }).click();
    await expect(admin.getByTestId('mode-cash')).toContainText('₹800');
    await expect(admin.getByTestId('collection-payments')).toContainText('R00001');

    await admin.getByRole('link', { name: 'Audit log' }).click();
    await admin.getByLabel('Area').selectOption({ label: 'Prescriptions' });
    const entries = admin.getByTestId('audit-entries');
    await expect(entries).toContainText('prescription.signed');
    await expect(entries).toContainText('Dr. Synthetic');
    await expect(entries).not.toContainText('Neha');
  });
});
