import type { Db } from '@dhc/db';
import { expect, setUpFromInvite, test, type Clinic } from '../fixtures';

const WEB_URL = 'http://localhost:3300';
const today = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

/** A booking for later today with the doctor, for a patient the doctor has never seen. */
async function booking(db: Db, clinic: Clinic) {
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
  const startAt = new Date(Date.now() + 60 * 60_000);
  const row = await db.appointment.create({
    data: {
      organisationId: org.id,
      patientId: patient.id,
      doctorUserId: doctor.id,
      clinicId: place.id,
      consultationTypeId: type.id,
      date: new Date(`${today()}T00:00:00Z`),
      startAt,
      endAt: new Date(startAt.getTime() + 15 * 60_000),
      status: 'confirmed',
      source: 'front_desk',
      tokenNumber: 1,
      createdByUserId: doctor.id,
    },
  });
  return row.id;
}

test.describe('clinic admin: chart, safety alerts and files', () => {
  test('the admin limits the chart to own patients, hides an alert and sets upload limits', async ({
    page,
    browser,
    clinic,
    db,
  }) => {
    const visitId = await booking(db, clinic);
    await setUpFromInvite(page, clinic.inviteLink('clinic_admin'), 'admin synthetic passphrase');

    const form = page.getByTestId('clinic-policies');
    await expect(form.getByLabel(/^Shared chart/)).toBeChecked();
    await form.getByLabel(/^Own patients only/).check();
    const olderAdults = form.getByLabel('Medicines to use with care in adults 65 and over');
    await expect(olderAdults).toBeChecked();
    await olderAdults.uncheck();
    await form.getByLabel(/^Largest file/).fill('5');
    await form.getByLabel('PNG image').uncheck();
    await form.getByLabel('iPhone photo (HEIC)').check();
    await form.getByRole('button', { name: 'Save' }).click();
    await expect(form.getByRole('status')).toHaveText('Saved.');

    // A clinic needs at least one file type.
    for (const type of ['PDF', 'JPEG photo', 'iPhone photo (HEIC)']) {
      await form.getByLabel(type).uncheck();
    }
    await form.getByRole('button', { name: 'Save' }).click();
    const card = page.getByRole('region', { name: 'Chart, safety alerts and files' });
    await expect(card.getByRole('alert')).toHaveText('Choose at least one file type.');

    await page.reload();
    const saved = page.getByTestId('clinic-policies');
    await expect(saved.getByLabel(/^Own patients only/)).toBeChecked();
    await expect(
      saved.getByLabel('Medicines to use with care in adults 65 and over'),
    ).not.toBeChecked();
    await expect(saved.getByLabel('Moderate and minor drug interactions')).toBeChecked();
    await expect(saved.getByLabel(/^Largest file/)).toHaveValue('5');
    await expect(saved.getByLabel('PNG image')).not.toBeChecked();
    await expect(saved.getByLabel('iPhone photo (HEIC)')).toBeChecked();

    await page.getByRole('link', { name: 'Audit log' }).click();
    await page.getByLabel('Area').selectOption({ label: 'Settings' });
    await expect(page.getByTestId('audit-entries')).toContainText('settings.updated');

    // The doctor has a booking with this patient but has not seen them: no chart yet.
    const context = await browser.newContext({ baseURL: WEB_URL });
    const doctor = await context.newPage();
    await setUpFromInvite(doctor, clinic.inviteLink('doctor'), 'doctor synthetic passphrase');
    await doctor.goto(`/clinic/consultations/${visitId}`);
    await expect(doctor.getByRole('alert').filter({ hasText: 'chart' })).toContainText(
      'This clinic opens a patient’s chart only to the doctors who have seen them.',
    );
    await context.close();
  });
});
