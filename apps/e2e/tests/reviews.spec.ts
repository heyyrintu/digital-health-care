import { randomUUID } from 'node:crypto';
import { withMessaging } from '@dhc/db';
import { createReviewLinkToken } from '../../../packages/secure-links/src/index';
import { expect, setUpFromInvite, signInAsPatient, syntheticMobile, test } from '../fixtures';
const secret = 'synthetic-browser-review-secret-32-characters';
for (const width of [390, 1280]) {
  test(`Review consent, request, delivery and explicit open tracking (${width}px)`, async ({
    page,
    db,
    clinic,
    browser,
  }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    await setUpFromInvite(page, clinic.inviteLink('clinic_admin'), 'synthetic admin passphrase');
    const org = await db.organisation.findUniqueOrThrow({ where: { slug: clinic.slug } }),
      patient = await db.patient.findFirstOrThrow({
        where: { organisationId: org.id, name: 'Asha Verma' },
      }),
      admin = await db.user.findUniqueOrThrow({ where: { email: clinic.email('clinic_admin') } });
    const phone = syntheticMobile();
    await db.patient.update({ where: { id: patient.id }, data: { phone: '+91' + phone } });
    // A completed synthetic visit; no consultation text or real care is created.
    const doctor = await db.user.findUniqueOrThrow({ where: { email: clinic.email('doctor') } });
    const place = await db.clinic.create({
        data: { organisationId: org.id, name: 'Synthetic site' },
      }),
      type = await db.consultationType.create({
        data: {
          organisationId: org.id,
          name: 'Synthetic visit',
          mode: 'in_person',
          defaultDurationMin: 15,
          feePaise: 0,
        },
      });
    const start = new Date(Date.now() - 3600000),
      date = new Date(start.getTime() + 330 * 60000).toISOString().slice(0, 10);
    await db.appointment.create({
      data: {
        organisationId: org.id,
        patientId: patient.id,
        doctorUserId: doctor.id,
        clinicId: place.id,
        consultationTypeId: type.id,
        date: new Date(date),
        startAt: start,
        endAt: new Date(start.getTime() + 900000),
        status: 'completed',
        source: 'front_desk',
        tokenNumber: 1,
        createdByUserId: admin.id,
      },
    });
    await page.goto('/clinic/reviews');
    await page
      .getByLabel('Direct Google review link', { exact: true })
      .fill('https://g.page/r/SyntheticClinic/review');
    await page
      .getByRole('checkbox', { name: 'Allow optional review invitations', exact: true })
      .check();
    await page.getByRole('button', { name: 'Save review settings', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('Review settings saved.');
    const context = await browser.newContext({ viewport: { width, height: 1000 } }),
      portal = await context.newPage();
    await signInAsPatient(portal, db, clinic, phone);
    await expect(
      portal.getByRole('checkbox', { name: 'I have read the privacy notice' }),
    ).toBeVisible();
    await portal.goto('/app/reviews');
    await portal
      .getByRole('checkbox', {
        name: 'I agree to optional WhatsApp invitations to leave an honest Google review.',
        exact: true,
      })
      .check();
    await portal.getByRole('button', { name: 'Allow review invitations', exact: true }).click();
    await expect(
      portal.getByText('Optional review invitations are on.', { exact: true }),
    ).toBeVisible();
    expect(await db.accountConsent.count({ where: { organisationId: org.id } })).toBe(0);
    await page.getByLabel('Visit date', { exact: true }).fill(date);
    await page.getByRole('button', { name: 'Load completed visits', exact: true }).click();
    await page
      .getByRole('combobox', { name: 'Completed visit', exact: true })
      .selectOption({ index: 1 });
    await page.getByRole('button', { name: 'Request an honest review', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText(
      'Review invitation queued. Queued does not mean sent.',
    );
    const r = await db.reviewRequest.findFirstOrThrow({ where: { organisationId: org.id } });
    // Fake provider acceptance only: the real authorization and receipt SQL are exercised without an external send.
    await withMessaging(db, async (tx) => {
      await tx.$queryRaw`SELECT * FROM messaging_begin_review_notice(${r.id}::uuid,${'1234'})`;
      await tx.$executeRaw`SELECT messaging_finish_review_notice(${r.id}::uuid,${'1234'},${'accepted'},${'synthetic-' + r.id})`;
      const event = randomUUID();
      await tx.$queryRaw`SELECT messaging_receive_status(${event}::uuid,${'1234'},${'synthetic-' + r.id},${r.id}::uuid,${'delivered'},${new Date()},${null}::integer)`;
      await tx.$executeRaw`SELECT messaging_process_status(${event}::uuid)`;
    });
    const invitation = await context.newPage();
    await invitation.route('https://g.page/**', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<h1>Synthetic Google destination</h1>' }),
    );
    const token = createReviewLinkToken(r.id, r.expiresAt, secret);
    await invitation.goto('/review#' + token);
    await expect(invitation.getByRole('button', { name: /Continue to Google/ })).toBeVisible();
    expect((await db.reviewRequest.findUniqueOrThrow({ where: { id: r.id } })).openedAt).toBeNull();
    await invitation.screenshot({
      path: info.outputPath(`review-invitation-${width}.png`),
      fullPage: true,
    });
    await invitation.getByRole('button', { name: /Continue to Google/ }).click();
    await expect(invitation).toHaveURL('https://g.page/r/SyntheticClinic/review');
    await page.getByRole('button', { name: 'Refresh review requests', exact: true }).click();
    await expect(page.getByText('Review link opened', { exact: true })).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: info.outputPath(`review-tracking-${width}.png`),
      fullPage: true,
    });
    await portal.getByRole('button', { name: 'Stop review invitations', exact: true }).click();
    await expect(
      portal.getByText('Optional review invitations are off.', { exact: true }),
    ).toBeVisible();
    await invitation.goto('/review#' + token);
    await expect(invitation.locator('main [role=alert]')).toContainText('unavailable or expired');
    await context.close();
  });
}
