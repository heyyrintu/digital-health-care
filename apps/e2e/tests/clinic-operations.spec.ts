import { randomUUID } from 'node:crypto';
import { expect, setUpFromInvite, signInAsPatient, syntheticMobile, test } from '../fixtures';
import { istDateKey, addDays } from '../../../packages/domain/src/index';
for (const width of [390, 1280])
  test(`bulk session move recovers one apply, preserves a bill, then publishes a delay (${width}px)`, async ({
    page,
    db,
    clinic,
    browser,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await setUpFromInvite(page, clinic.inviteLink('clinic_admin'), 'admin synthetic passphrase');
    const org = await db.organisation.findUniqueOrThrow({ where: { slug: clinic.slug } }),
      doc = await db.user.findUniqueOrThrow({ where: { email: clinic.email('doctor') } });
    await db.membership.updateMany({
      where: { organisationId: org.id, userId: doc.id, role: 'doctor' },
      data: { status: 'active' },
    });
    const patients = await db.patient.findMany({
        where: { organisationId: org.id },
        orderBy: { uhid: 'asc' },
      }),
      place = await db.clinic.create({
        data: { organisationId: org.id, name: 'Operations clinic' },
      }),
      type = await db.consultationType.create({
        data: {
          organisationId: org.id,
          name: 'Visit',
          mode: 'in_person',
          defaultDurationMin: 15,
          feePaise: 10000,
        },
      }),
      today = istDateKey(new Date()),
      source = addDays(today, 1),
      target = addDays(today, 2),
      at = (d: string, time: string) => new Date(`${d}T${time}:00+05:30`);
    await db.availabilityVersion.create({
      data: {
        organisationId: org.id,
        doctorUserId: doc.id,
        clinicId: place.id,
        consultationTypeId: type.id,
        effectiveFrom: new Date(today),
        weekly: Object.fromEntries(
          ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((day) => [
            day,
            [{ start: '09:00', end: '13:00' }],
          ]),
        ),
        slotMinutes: 15,
        bufferMinutes: 0,
        createdByUserId: doc.id,
      },
    });
    const visits = [];
    for (let i = 0; i < 2; i++) {
      const start = at(source, i === 0 ? '09:00' : '09:15');
      visits.push(
        await db.appointment.create({
          data: {
            organisationId: org.id,
            patientId: patients[i]!.id,
            doctorUserId: doc.id,
            clinicId: place.id,
            consultationTypeId: type.id,
            date: new Date(source),
            startAt: start,
            endAt: new Date(start.getTime() + 900000),
            tokenNumber: i + 1,
            status: 'confirmed',
            source: 'front_desk',
            createdByUserId: doc.id,
          },
        }),
      );
    }
    await db.bill.create({
      data: {
        organisationId: org.id,
        appointmentId: visits[0]!.id,
        patientId: patients[0]!.id,
        doctorUserId: doc.id,
        subtotalPaise: 10000,
        totalPaise: 10000,
        status: 'due',
        createdByUserId: doc.id,
      },
    });
    const phone = syntheticMobile();
    await db.patient.update({ where: { id: patients[1]!.id }, data: { phone: '+91' + phone } });
    await db.whatsAppOptIn.create({
      data: {
        id: randomUUID(),
        organisationId: org.id,
        phone: '+91' + phone,
        senderPhoneNumberId: '1234',
        category: 'appointments',
        enabled: true,
        changedAt: new Date(),
      },
    });
    await page.goto('/clinic/session-operations');
    await page
      .getByRole('combobox', { name: 'Change type', exact: true })
      .selectOption('reschedule');
    await page.getByLabel('Source date', { exact: true }).fill(source);
    await page.getByLabel('Session start', { exact: true }).fill('09:00');
    await page.getByLabel('Session end', { exact: true }).fill('10:00');
    await page.getByLabel('Destination date', { exact: true }).fill(target);
    await page.getByLabel('Destination start', { exact: true }).fill('10:00');
    await page
      .getByRole('textbox', { name: 'Reason visible in appointment history', exact: true })
      .fill('Doctor schedule changed');
    await page
      .getByRole('checkbox', {
        name: 'Queue an additional WhatsApp update for recipients with appointment-message consent',
      })
      .check();
    await page.getByRole('button', { name: 'Preview changes', exact: true }).click();
    const preview = page.getByRole('region', { name: 'Change preview', exact: true });
    await expect(preview).toContainText(
      'bill or prepaid booking needs individual financial review',
    );
    await page
      .getByRole('checkbox', {
        name: 'I reviewed every affected appointment and confirm this session change.',
      })
      .check();
    await expect(
      page.getByRole('button', { name: 'Apply reviewed changes', exact: true }),
    ).toBeDisabled();
    await page
      .getByRole('checkbox', {
        name: 'I understand the unchanged appointments still need individual review and patient contact.',
      })
      .check();
    let interrupted = false,
      operation = '';
    await page.route('**/v1/clinic-operations/*/apply', async (route) => {
      const id = route.request().url().split('/').at(-2)!;
      if (operation) expect(id).toBe(operation);
      operation = id;
      const response = await route.fetch();
      if (!interrupted) {
        interrupted = true;
        expect(response.status()).toBe(200);
        await route.abort('failed');
      } else await route.fulfill({ response });
    });
    await page.getByRole('button', { name: 'Apply reviewed changes', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Recover same operation', exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel('Source date', { exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Recover same operation', exact: true }).click();
    await expect(page.getByRole('status')).toContainText(
      '1 changed · 1 left unchanged · 1 additional notices queued',
    );
    expect(await db.appointment.count({ where: { rescheduledFromId: visits[1]!.id } })).toBe(1);
    expect((await db.appointment.findUniqueOrThrow({ where: { id: visits[0]!.id } })).status).toBe(
      'confirmed',
    );
    expect(
      await db.clinicOperation.count({ where: { organisationId: org.id, state: 'applied' } }),
    ).toBe(1);
    expect(
      await db.whatsAppDelivery.count({
        where: { organisationId: org.id, kind: 'appointment_update' },
      }),
    ).toBe(1);
    const waitingPhone = syntheticMobile();
    await db.patient.update({
      where: { id: patients[2]!.id },
      data: { phone: '+91' + waitingPhone, dob: new Date('1990-01-01'), gender: 'female' },
    });
    const waitStart = new Date(Date.now() - 900000),
      waiting = await db.appointment.create({
        data: {
          organisationId: org.id,
          patientId: patients[2]!.id,
          doctorUserId: doc.id,
          clinicId: place.id,
          consultationTypeId: type.id,
          date: new Date(today),
          startAt: waitStart,
          endAt: new Date(waitStart.getTime() + 900000),
          tokenNumber: 1,
          status: 'checked_in',
          source: 'walk_in',
          createdByUserId: doc.id,
        },
      });
    await page.getByRole('combobox', { name: 'Change type', exact: true }).selectOption('delay');
    await page.getByLabel('Source date', { exact: true }).fill(today);
    await page.getByLabel('Session start', { exact: true }).fill('00:00');
    await page.getByLabel('Session end', { exact: true }).fill('23:59');
    await page
      .getByRole('spinbutton', { name: 'Estimated delay in minutes (0 clears it)', exact: true })
      .fill('45');
    await page
      .getByRole('textbox', { name: 'Reason visible in appointment history', exact: true })
      .fill('Doctor running late');
    await page
      .getByRole('checkbox', {
        name: 'Queue an additional WhatsApp update for recipients with appointment-message consent',
      })
      .uncheck();
    await page.getByRole('button', { name: 'Preview changes', exact: true }).click();
    await page
      .getByRole('checkbox', {
        name: 'I reviewed every affected appointment and confirm this session change.',
      })
      .check();
    await page.unroute('**/v1/clinic-operations/*/apply');
    await page.getByRole('button', { name: 'Apply reviewed changes', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('1 changed');
    expect(
      (await db.appointment.findUniqueOrThrow({ where: { id: waiting.id } })).startAt.getTime(),
    ).toBe(waitStart.getTime());
    const patientContext = await browser.newContext(),
      patientPage = await patientContext.newPage();
    await signInAsPatient(patientPage, db, clinic, waitingPhone);
    await patientPage.getByRole('checkbox', { name: 'I have read the privacy notice' }).check();
    await patientPage.getByRole('checkbox', { name: 'I accept the terms of use' }).check();
    await patientPage.getByRole('checkbox', { name: /health records/i }).check();
    await patientPage.getByRole('button', { name: 'Accept and continue' }).click();
    await expect(patientPage.getByRole('navigation')).toBeVisible();
    await patientPage.goto('/app/appointments');
    await expect(
      patientPage.getByText('Clinic delay estimate: 45 minutes.', { exact: false }),
    ).toBeVisible();
    await patientContext.close();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  });
