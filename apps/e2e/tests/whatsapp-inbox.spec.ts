import { randomUUID } from 'node:crypto';
import { FieldCipher } from '../../api/src/auth/field-cipher';
import { E2E_FIELD_ENCRYPTION_KEY } from '../env';
import { expect, setUpFromInvite, test } from '../fixtures';
const cipher = new FieldCipher(E2E_FIELD_ENCRYPTION_KEY);
for (const width of [390, 1280])
  test(`front desk recovers one WhatsApp reply and hands a conversation to a doctor (${width}px)`, async ({
    page,
    db,
    clinic,
    browser,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const org = await db.organisation.findUniqueOrThrow({ where: { slug: clinic.slug } }),
      sender = '7' + String(Date.now()) + String(width),
      threadId = randomUUID(),
      now = new Date(),
      templateId = randomUUID();
    await db.inboxChannel.create({
      data: { organisationId: org.id, senderId: sender, businessId: '5678', createdAt: now },
    });
    await db.inboxThread.create({
      data: {
        id: threadId,
        organisationId: org.id,
        senderId: sender,
        contactKey: randomUUID(),
        phoneCipher: cipher.encrypt('+919876543210'),
        last4: '3210',
        lastInboundAt: now,
        updatedAt: now,
        unread: 1,
      },
    });
    await db.inboxMessage.create({
      data: {
        id: randomUUID(),
        organisationId: org.id,
        threadId,
        senderId: sender,
        providerId: 'wamid.in.' + threadId,
        direction: 'inbound',
        kind: 'text',
        bodyCipher: cipher.encrypt('Please help me change my appointment.'),
        state: 'received',
        occurredAt: now,
        createdAt: now,
        statusAt: now,
      },
    });
    await db.inboxTemplate.create({
      data: {
        id: templateId,
        organisationId: org.id,
        senderId: sender,
        providerId: sender + '1',
        name: 'clinic_service',
        language: 'en',
        category: 'UTILITY',
        providerStatus: 'APPROVED',
        bodyCipher: cipher.encrypt('Please contact the clinic about your request.'),
        contentHash: 'synthetic',
        supported: true,
        verifiedAt: now,
      },
    });
    // Browser-only fake transport: API authorization/dispatch are covered by integration tests.
    // No provider configuration or live provider call exists in this browser environment.
    const adminContext = await browser.newContext(),
      admin = await adminContext.newPage();
    await admin.route('**/v1/inbox/templates', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({ response, json: { ...body, available: true } });
    });
    await setUpFromInvite(admin, clinic.inviteLink('clinic_admin'), 'admin synthetic passphrase');
    await admin.goto('/clinic/message-templates');
    await expect(
      admin.getByRole('heading', { name: 'Message templates', exact: true }),
    ).toBeVisible();
    await admin.getByRole('button', { name: 'Enable for inbox replies' }).click();
    await expect(admin.getByRole('button', { name: 'Disable', exact: true })).toBeVisible();
    expect((await db.inboxTemplate.findUniqueOrThrow({ where: { id: templateId } })).enabled).toBe(
      true,
    );
    await adminContext.close();
    const doctorContext = await browser.newContext(),
      clinician = await doctorContext.newPage();
    await setUpFromInvite(clinician, clinic.inviteLink('doctor'), 'doctor synthetic passphrase');
    await page.route('**/v1/inbox?*', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({ response, json: { ...body, available: true } });
    });
    let first = true,
      lastId = '';
    await page.route(`**/v1/inbox/threads/${threadId}/messages`, async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue();
        return;
      }
      const body = route.request().postDataJSON() as { id: string; text: string };
      if (lastId) expect(body.id).toBe(lastId);
      lastId = body.id;
      let row = await db.inboxMessage.findUnique({ where: { id: body.id } });
      if (!row) {
        const user = await db.user.findUniqueOrThrow({
          where: { email: clinic.email('front_desk') },
        });
        row = await db.inboxMessage.create({
          data: {
            id: body.id,
            organisationId: org.id,
            threadId,
            senderId: sender,
            direction: 'outbound',
            kind: 'text',
            bodyCipher: cipher.encrypt(body.text),
            inputHash: 'synthetic',
            state: 'accepted',
            occurredAt: new Date(),
            createdAt: new Date(),
            statusAt: new Date(),
            sentByUserId: user.id,
            sentByRole: 'front_desk',
          },
        });
      }
      if (first) {
        first = false;
        await route.abort('failed');
        return;
      }
      await route.fulfill({
        json: {
          id: row.id,
          direction: row.direction,
          kind: row.kind,
          body: cipher.decrypt(row.bodyCipher),
          state: row.state,
          createdAt: row.createdAt.toISOString(),
          occurredAt: row.occurredAt.toISOString(),
          errorCode: null,
        },
      });
    });
    await setUpFromInvite(page, clinic.inviteLink('front_desk'), 'desk synthetic passphrase');
    await page.goto('/clinic/inbox');
    await page.getByRole('button', { name: 'Open conversation', exact: true }).click();
    await expect(page.getByRole('list', { name: 'Messages', exact: true })).toContainText(
      'Please help me change my appointment.',
    );
    await page.getByRole('button', { name: 'Mark as read', exact: true }).click();
    await expect
      .poll(
        async () => (await db.inboxThread.findUniqueOrThrow({ where: { id: threadId } })).unread,
      )
      .toBe(0);
    await page
      .getByLabel('Your reply', { exact: true })
      .fill('Please call reception to choose another time.');
    await page.getByRole('button', { name: 'Send reply', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Recover same reply', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Your reply', exact: true })).toBeDisabled();
    await expect(page.getByRole('combobox', { name: 'Conversations', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Recover same reply', exact: true }).click();
    await expect(page.getByRole('list', { name: 'Messages', exact: true })).toContainText(
      'Please call reception to choose another time.',
    );
    expect(await db.inboxMessage.count({ where: { threadId, direction: 'outbound' } })).toBe(1);
    await page
      .getByRole('checkbox', {
        name: 'The number holder explicitly agreed to clinic service messages on WhatsApp.',
      })
      .check();
    await page.getByRole('button', { name: 'Record agreement', exact: true }).click();
    await expect
      .poll(
        async () =>
          (await db.inboxThread.findUniqueOrThrow({ where: { id: threadId } })).optedInAt !== null,
      )
      .toBe(true);
    await page.getByRole('button', { name: 'Stop service messages', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Send reply', exact: true })).toBeDisabled();
    const doctor = await db.user.findUniqueOrThrow({ where: { email: clinic.email('doctor') } });
    await page
      .getByRole('combobox', { name: 'Assign to doctor', exact: true })
      .selectOption(doctor.id);
    await page.getByRole('button', { name: 'Assign to doctor', exact: true }).click();
    await expect(
      page.getByText('Message content is restricted to the assigned team.', { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('list', { name: 'Messages', exact: true })).toHaveCount(0);
    await clinician.goto('/clinic/inbox');
    await clinician.getByRole('button', { name: 'Open conversation', exact: true }).click();
    await expect(clinician.getByRole('list', { name: 'Messages', exact: true })).toContainText(
      'Please help me change my appointment.',
    );
    await doctorContext.close();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  });
