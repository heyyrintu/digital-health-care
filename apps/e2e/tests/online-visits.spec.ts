import { expect, setUpFromInvite, signInAsPatient, syntheticMobile, test } from '../fixtures';
for (const width of [390, 1280]) {
  test(`Online self-booking, private call, doctor verification and withdrawal (${width}px)`, async ({
    page,
    db,
    clinic,
    browser,
  }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    await setUpFromInvite(page, clinic.inviteLink('clinic_admin'), 'synthetic admin passphrase');
    const doctorContext = await browser.newContext({ viewport: { width, height: 1000 } }),
      doctorPage = await doctorContext.newPage();
    await setUpFromInvite(doctorPage, clinic.inviteLink('doctor'), 'synthetic doctor passphrase');
    const org = await db.organisation.findUniqueOrThrow({ where: { slug: clinic.slug } }),
      doctor = await db.user.findUniqueOrThrow({ where: { email: clinic.email('doctor') } }),
      patient = await db.patient.findFirstOrThrow({
        where: { organisationId: org.id, name: 'Asha Verma' },
      }),
      phone = syntheticMobile();
    const dob = width === 390 ? '2016-01-01' : '1990-01-01';
    await db.patient.update({
      where: { id: patient.id },
      data: { phone: '+91' + phone, dob: new Date(dob) },
    });
    await db.doctorProfile.create({
      data: {
        organisationId: org.id,
        userId: doctor.id,
        registrationNumber: 'SYNTHETIC001',
        council: 'Synthetic council',
        qualifications: 'Synthetic qualification',
        verification: 'verified',
        verifiedAt: new Date(),
      },
    });
    const place = await db.clinic.create({
        data: { organisationId: org.id, name: 'Synthetic clinic' },
      }),
      type = await db.consultationType.create({
        data: {
          organisationId: org.id,
          name: 'Video consultation',
          mode: 'video',
          defaultDurationMin: 20,
          feePaise: 0,
        },
      });
    const hours = [{ start: '09:00', end: '10:00' }];
    await db.availabilityVersion.create({
      data: {
        organisationId: org.id,
        doctorUserId: doctor.id,
        clinicId: place.id,
        consultationTypeId: type.id,
        effectiveFrom: new Date('2026-01-01'),
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
    await page.goto('/clinic/online');
    await page.getByRole('checkbox', { name: 'Enable online consultations', exact: true }).check();
    await page.getByRole('button', { name: 'Save online settings', exact: true }).click();
    await expect
      .poll(
        async () =>
          (await db.onlineVisitSettings.findUnique({ where: { organisationId: org.id } }))?.enabled,
      )
      .toBe(true);
    const patientContext = await browser.newContext({ viewport: { width, height: 1000 } }),
      portal = await patientContext.newPage();
    await signInAsPatient(portal, db, clinic, phone);
    await portal.getByRole('checkbox', { name: 'I have read the privacy notice' }).check();
    await portal.getByRole('checkbox', { name: 'I accept the terms of use' }).check();
    await portal.getByRole('checkbox', { name: /health records/i }).check();
    await portal.getByRole('button', { name: 'Accept and continue' }).click();
    await portal
      .getByRole('navigation')
      .getByRole('link', { name: 'Book appointment', exact: true })
      .click();
    await portal
      .getByRole('group', { name: 'Date', exact: true })
      .getByRole('button')
      .nth(1)
      .click();
    await portal.locator('[data-slot="09:20"]').click();
    await portal.getByRole('button', { name: /^Book 09:20/ }).click();
    await expect(portal.getByRole('status')).toContainText(/Booked for/);
    const visit = await db.appointment.findFirstOrThrow({
      where: { organisationId: org.id, patientId: patient.id },
    });
    // Move the synthetic fixture into today's join window before any online intake is recorded.
    const start = new Date();
    await db.appointment.update({
      where: { id: visit.id },
      data: {
        date: new Date(new Date(start.getTime() + 330 * 60000).toISOString().slice(0, 10)),
        startAt: start,
        endAt: new Date(start.getTime() + 20 * 60000),
      },
    });
    await page.goto('/clinic/online/' + visit.id);
    await page
      .getByLabel('Private meeting URL (Google Meet, Zoom or Teams)', { exact: true })
      .fill('https://meet.google.com/abc-defg-hij');
    await page.getByRole('button', { name: 'Save call details', exact: true }).click();
    await expect(
      page.getByLabel('Private meeting URL (Google Meet, Zoom or Teams)', { exact: true }),
    ).toHaveValue('https://meet.google.com/abc-defg-hij');
    await expect
      .poll(
        async () =>
          (await db.onlineVisit.findUnique({ where: { appointmentId: visit.id } }))?.version,
      )
      .toBe(1);
    await portal.goto('/app/online/' + visit.id);
    await portal.getByLabel('Full patient name', { exact: true }).fill('Asha Verma');
    await portal.getByLabel('Patient date of birth', { exact: true }).fill(dob);
    await portal
      .getByLabel('Patient current address', { exact: true })
      .fill('Synthetic address, India');
    if (width === 390) {
      await portal
        .getByLabel('Adult guardian name (required for minors)', { exact: true })
        .fill('Synthetic Guardian');
      await portal.getByLabel('Guardian relationship', { exact: true }).fill('parent');
    }
    await portal.getByRole('checkbox', { name: /The identity details are accurate/ }).check();
    await portal.getByRole('button', { name: 'Save identity and consent', exact: true }).click();
    await expect(portal.getByRole('status')).toHaveText('Consent recorded for this appointment');
    await doctorPage.goto('/clinic/online/' + visit.id);
    await doctorPage
      .getByRole('checkbox', { name: /I confirmed the patient's identity and age/ })
      .check();
    if (width === 390) {
      await expect(
        doctorPage.getByRole('button', { name: 'Confirm doctor identity check', exact: true }),
      ).toBeDisabled();
      await doctorPage.getByRole('checkbox', { name: /I separately verified/ }).check();
    } else
      await expect(doctorPage.getByRole('checkbox', { name: /I separately verified/ })).toHaveCount(
        0,
      );
    await doctorPage
      .getByRole('button', { name: 'Confirm doctor identity check', exact: true })
      .click();
    await expect(doctorPage.getByRole('status')).toHaveText(
      'Identity verified by the assigned doctor',
    );
    await doctorPage.screenshot({
      path: info.outputPath(`online-doctor-${width}.png`),
      fullPage: true,
    });
    await portal.getByRole('button', { name: 'Reload online details', exact: true }).click();
    await expect(
      portal.getByRole('button', { name: 'Connect using clinic details', exact: true }),
    ).toBeEnabled();
    await portal.screenshot({
      path: info.outputPath(`online-patient-${width}.png`),
      fullPage: true,
    });
    await portal.route('https://meet.google.com/**', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<h1>Synthetic external meeting</h1>' }),
    );
    await portal.getByRole('button', { name: 'Connect using clinic details', exact: true }).click();
    await expect(portal).toHaveURL('https://meet.google.com/abc-defg-hij');
    await portal.goto('/app/online/' + visit.id);
    await portal.getByRole('button', { name: 'Withdraw online consent', exact: true }).click();
    await expect(portal.getByRole('status')).toHaveText('No current consent for this appointment');
    await expect(
      portal.getByRole('button', { name: 'Connect using clinic details', exact: true }),
    ).toBeDisabled();
    await patientContext.close();
    await doctorContext.close();
  });
}
