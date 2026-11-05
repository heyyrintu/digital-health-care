import { randomUUID } from 'node:crypto';
import { expect, setUpFromInvite, test } from '../fixtures';

test('clinic admin sees WhatsApp statuses and can refresh, without patient information', async ({
  page,
  clinic,
  db,
}) => {
  const org = await db.organisation.findUniqueOrThrow({ where: { slug: clinic.slug } });
  const challengeId = randomUUID();
  const deliveryId = randomUUID();
  const now = new Date();
  await db.otpChallenge.create({
    data: {
      id: challengeId,
      organisationId: org.id,
      phone: '+919876543210',
      codeHash: 'synthetic-no-real-code',
      expiresAt: new Date(now.getTime() + 300_000),
    },
  });
  await db.$executeRaw`SELECT auth_create_whatsapp_delivery(${challengeId}::uuid, ${deliveryId}::uuid, ${'1234'}, ${now})`;
  await db.$executeRaw`SELECT auth_accept_whatsapp_delivery(${deliveryId}::uuid, ${'wamid.synthetic.' + deliveryId}, ${now})`;
  await setUpFromInvite(page, clinic.inviteLink('clinic_admin'), 'admin synthetic passphrase');
  await page.getByRole('link', { name: 'WhatsApp delivery' }).click();
  await expect(page.getByRole('heading', { name: 'WhatsApp delivery' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Accepted by Meta', exact: true })).toBeVisible();
  await expect(page.getByRole('table')).not.toContainText('9876543210');
  await expect(page.getByRole('table')).not.toContainText('wamid.');

  const eventId = randomUUID();
  await db.$queryRaw`SELECT messaging_receive_status(${eventId}::uuid, ${'1234'}, ${'wamid.synthetic.' + deliveryId}, ${deliveryId}::uuid, ${'delivered'}, ${now}, ${null}::integer)`;
  await db.$executeRaw`SELECT messaging_process_status(${eventId}::uuid)`;
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'Delivered', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'हिंदी', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'WhatsApp डिलीवरी' })).toBeVisible();
});
