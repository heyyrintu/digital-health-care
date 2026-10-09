import type { Db } from '@dhc/db';
import { expect, setUpFromInvite, test, type Clinic } from '../fixtures';

/** Asha registered twice: the duplicate has an allergy the kept record lacks. */
async function duplicate(db: Db, clinic: Clinic) {
  const org = await db.organisation.findUniqueOrThrow({ where: { slug: clinic.slug } });
  const desk = await db.user.findUniqueOrThrow({ where: { email: clinic.email('front_desk') } });
  const kept = await db.patient.findFirstOrThrow({
    where: { organisationId: org.id, name: 'Asha Verma' },
  });
  const dup = await db.patient.create({
    data: { organisationId: org.id, uhid: 'E2E-000099', name: 'Asha V.' },
  });
  await db.allergy.create({
    data: {
      organisationId: org.id,
      patientId: dup.id,
      substance: 'Penicillin',
      source: 'patient',
      recordedByUserId: desk.id,
    },
  });
  return { kept, dup };
}

test.describe('patient merges', () => {
  test('the front desk asks, the clinic admin approves, and the duplicate closes', async ({
    page,
    browser,
    clinic,
    db,
  }) => {
    await setUpFromInvite(page, clinic.inviteLink('front_desk'), 'desk synthetic passphrase');
    const { kept, dup } = await duplicate(db, clinic);

    // The front desk finds the other record and asks for the merge.
    await page.goto(`/clinic/patients/${dup.id}`);
    await page.getByRole('button', { name: 'Merge a duplicate record' }).click();
    const panel = page.getByTestId('merge-panel');
    await panel.getByLabel('Find the other record').fill('Asha Verma');
    await panel.getByRole('button', { name: 'Search' }).click();
    await panel.getByRole('button', { name: `Choose Asha Verma · ${kept.uhid}` }).click();
    await panel.getByLabel(`Keep Asha Verma · ${kept.uhid}`).check();
    await expect(panel).toContainText(`After approval, E2E-000099 closes`);
    await panel.getByLabel('Why are these the same person?').fill('Same person, registered twice');
    await panel.getByRole('button', { name: 'Send to clinic admin' }).click();
    await expect(page.getByTestId('pending-merge')).toHaveText(
      `Waiting for a clinic admin to merge E2E-000099 into ${kept.uhid}.`,
    );

    // The clinic admin compares the records and approves.
    const admin = await (
      await browser.newContext({ baseURL: test.info().project.use.baseURL })
    ).newPage();
    await setUpFromInvite(admin, clinic.inviteLink('clinic_admin'), 'admin synthetic passphrase');
    await admin.getByRole('link', { name: 'Patient merges' }).click();
    const request = admin.getByTestId('merge-E2E-000099');
    await expect(request).toContainText('Same person, registered twice');
    await expect(request.getByRole('row', { name: /UHID/ })).toContainText(
      `E2E-000099${kept.uhid}`,
    );
    await request.getByRole('button', { name: 'Approve merge' }).click();
    await expect(request).toContainText('This cannot be undone.');
    await request.getByRole('button', { name: 'Merge now' }).click();
    await expect(admin.getByRole('status')).toHaveText(`Merged E2E-000099 into ${kept.uhid}.`);
    await expect(admin.getByText('No merge requests waiting.')).toBeVisible();
    await expect(admin.getByTestId('decided-E2E-000099')).toContainText('Merged');

    // The duplicate is closed and points at the kept record, which lists it.
    await page.reload();
    await expect(page.getByTestId('merged-banner')).toContainText(
      `This record was merged into Asha Verma · ${kept.uhid}.`,
    );
    await expect(page.getByRole('button', { name: 'Edit details' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Book appointment' })).toHaveCount(0);
    await page.getByRole('link', { name: 'Open that record' }).click();
    await expect(page.getByTestId('merged-from')).toContainText('Also registered as E2E-000099');
    const moved = await db.allergy.findFirstOrThrow({
      where: { substance: 'Penicillin', patientId: { in: [kept.id, dup.id] } },
    });
    expect(moved.patientId).toBe(kept.id);

    // Searching by the old UHID leads to the kept record.
    await page.goto('/clinic');
    await page.getByRole('searchbox', { name: 'Search patients' }).fill('E2E-000099');
    await page.getByRole('button', { name: 'Search' }).click();
    await page.getByRole('link', { name: 'Merged: open the kept record' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Asha Verma' })).toBeVisible();
  });

  test('only the clinic admin can open the merge requests', async ({ page, clinic }) => {
    await setUpFromInvite(page, clinic.inviteLink('front_desk'), 'desk synthetic passphrase');
    await page.goto('/clinic/merges');
    await expect(page.getByText('This page is not available for your role.')).toBeVisible();
  });
});
