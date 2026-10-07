import type { Db } from '@dhc/db';
import { expect, setUpFromInvite, test, type Clinic } from '../fixtures';

const today = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

/** A clinic, a consultation type and an active doctor. */
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
  const patients = await db.patient.findMany({
    where: { organisationId: org.id },
    orderBy: { uhid: 'asc' },
  });
  /** A walk-in for today, `minutesAgo` after check-in, in the given status. */
  const walkIn = (
    patientIndex: number,
    tokenNumber: number,
    minutesAgo: number,
    status: 'checked_in' | 'in_consultation' = 'checked_in',
  ) => {
    const checkedInAt = new Date(Date.now() - minutesAgo * 60_000);
    return db.appointment.create({
      data: {
        organisationId: org.id,
        patientId: patients[patientIndex]!.id,
        doctorUserId: doctor.id,
        clinicId: place.id,
        consultationTypeId: type.id,
        date: new Date(`${today()}T00:00:00Z`),
        startAt: checkedInAt,
        endAt: new Date(checkedInAt.getTime() + 15 * 60_000),
        status,
        source: 'walk_in',
        tokenNumber,
        checkedInAt,
        consultationStartedAt: status === 'in_consultation' ? new Date() : null,
        createdByUserId: doctor.id,
      },
    });
  };
  return { org, doctor, place, patients, walkIn };
}

test.describe('queue and waiting-room screen', () => {
  test('My OPD puts the patient with the doctor first and priority patients ahead', async ({
    page,
    clinic,
    db,
  }) => {
    const { org, doctor, patients, walkIn } = await setUp(db, clinic);
    await walkIn(0, 1, 30, 'in_consultation'); // Asha, with the doctor
    await walkIn(1, 2, 20); // Ravi, waiting longest
    await walkIn(2, 3, 5); // Kamla, Emergency
    const tag = await db.tag.create({
      data: { organisationId: org.id, name: 'Emergency', colour: '#b91c1c', sortToTop: true },
    });
    await db.patientTag.create({
      data: {
        organisationId: org.id,
        patientId: patients[2]!.id,
        tagId: tag.id,
        addedByUserId: doctor.id,
      },
    });

    await setUpFromInvite(page, clinic.inviteLink('front_desk'), 'desk synthetic passphrase');
    await page.getByRole('link', { name: 'Queue' }).click();
    const rows = page.getByTestId('appointments').locator('li');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText('Asha Verma');
    await expect(rows.nth(0)).toContainText('With the doctor');
    await expect(rows.nth(1)).toContainText('Kamla Devi');
    await expect(rows.nth(1)).toContainText('Emergency');
    await expect(rows.nth(2)).toContainText('Ravi Mehra');
    await expect(rows.nth(2).getByTestId('waiting-time')).toContainText('Waiting 20 min');

    // Search and the tag filter narrow the list.
    await page.getByLabel('Search', { exact: true }).fill('ravi');
    await expect(rows).toHaveCount(1);
    await page.getByLabel('Search', { exact: true }).fill('');
    await page.getByLabel('Filter by tag').selectOption({ label: 'Emergency' });
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('Kamla Devi');
  });

  test('a clinic admin creates a screen link; the screen shows tokens, never names', async ({
    page,
    browser,
    clinic,
    db,
  }) => {
    const { walkIn } = await setUp(db, clinic);
    await walkIn(0, 4, 10, 'in_consultation');
    await walkIn(1, 5, 8);
    await walkIn(2, 6, 3);

    await setUpFromInvite(page, clinic.inviteLink('clinic_admin'), 'admin synthetic passphrase');
    const card = page.getByLabel('Waiting-room screens');
    await expect(card).toContainText('No screens yet.');
    await card.getByLabel('Screen name (e.g. Reception TV)').fill('Reception TV');
    await card.getByRole('button', { name: 'Create screen link' }).click();
    const link = await card.getByTestId('screen-link').innerText();
    expect(link).toMatch(/\/display#[\w-]{40,}$/);
    await expect(card.getByTestId('screen-Reception TV')).toContainText('Main clinic');

    // A separate kiosk browser with no sign-in.
    const kiosk = await browser.newPage();
    await kiosk.goto(link);
    await expect(kiosk.locator('h1')).toHaveText('Main clinic');
    await expect(kiosk.getByTestId('now-serving')).toHaveText('4');
    await expect(kiosk.getByTestId('next-tokens')).toHaveText('5  6');
    await expect(kiosk.locator('main')).not.toContainText('Asha');
    await expect(kiosk.locator('main')).not.toContainText('Ravi');

    // Revoking stops the link.
    await card.getByTestId('screen-Reception TV').getByRole('button', { name: 'Revoke' }).click();
    await expect(card).toContainText('No screens yet.');
    await kiosk.reload();
    await expect(kiosk.locator('main [role=alert]')).toContainText('This screen link is not valid');
    await kiosk.close();
  });
});
