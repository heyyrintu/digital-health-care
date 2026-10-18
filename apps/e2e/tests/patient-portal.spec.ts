import type { Db } from '@dhc/db';
import { expect, signInAsPatient, syntheticMobile, test, type Clinic } from '../fixtures';

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
  return { org };
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
    expect((await page.context().cookies()).some((c) => c.name.startsWith('dhc_patient'))).toBe(
      false,
    );
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
});
