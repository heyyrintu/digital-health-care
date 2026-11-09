import { WhatsAppDeliveryList } from '@dhc/contracts';
import { withAuth, withMessaging, withTenant } from '@dhc/db';
import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MetaWhatsAppOtpSender } from '../src/messaging/otp-sender';
import { bearer, createHarness, resetDatabase, seedTwoClinics, staffLogin } from './harness';

const h = createHarness();
const settings = {
  appSecret: 'synthetic-app-secret',
  verifyToken: 'synthetic-verification-token-32-characters',
  senderId: '1234',
  businessAccountId: '5678',
};
h.services.whatsappWebhook = settings;
h.services.otpSender = {
  channel: 'whatsapp',
  senderId: settings.senderId,
  send: async (phone, code, deliveryId) => {
    h.sentCodes.push({ phone, code });
    return { messageId: `wamid.${deliveryId}` };
  },
};
let clinics: Awaited<ReturnType<typeof seedTwoClinics>>;
beforeEach(async () => {
  vi.restoreAllMocks();
  await resetDatabase(h.owner);
  h.sentCodes.length = 0;
  clinics = await seedTwoClinics(h);
});
afterAll(async () => {
  await h.app.close();
  await h.owner.$disconnect();
});

async function createDelivery(organisation = 'clinic-a') {
  const r = await h.app.inject({
    method: 'POST',
    url: '/v1/auth/otp/request',
    payload: { organisation, phone: '9876543210' },
  });
  expect(r.statusCode, r.body).toBe(200);
  return h.owner.whatsAppDelivery.findUniqueOrThrow({
    where: { otpChallengeId: r.json().challengeId },
  });
}
type Delivery = Awaited<ReturnType<typeof createDelivery>>;
async function receipt(
  d: Pick<Delivery, 'id' | 'providerMessageId'>,
  status: string,
  offset = 0,
  overrides: Record<string, unknown> = {},
) {
  const payload = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: settings.businessAccountId,
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: settings.senderId },
              statuses: [
                {
                  id: d.providerMessageId ?? `wamid.${d.id}`,
                  biz_opaque_callback_data: d.id,
                  status,
                  timestamp: String(Math.floor(h.clock.ms / 1000) + offset),
                  recipient_id: '919876543210',
                  errors: [{ code: 131026, message: 'sensitive provider error' }],
                  ...overrides,
                },
              ],
            },
          },
        ],
      },
    ],
  });
  const signature =
    'sha256=' + createHmac('sha256', settings.appSecret).update(payload).digest('hex');
  const r = await h.app.inject({
    method: 'POST',
    url: '/v1/webhooks/whatsapp',
    payload,
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
  });
  expect(r.statusCode, r.body).toBe(200);
}
async function drain() {
  const pending = await withMessaging(
    h.services.db,
    (tx) => tx.$queryRaw<{ id: string }[]>`SELECT id FROM messaging_claim_status_events()`,
  );
  for (const e of pending)
    await withMessaging(
      h.services.db,
      (tx) => tx.$executeRaw`SELECT messaging_process_status(${e.id}::uuid)`,
    );
  return pending;
}
const row = (d: Delivery) => h.owner.whatsAppDelivery.findUniqueOrThrow({ where: { id: d.id } });

describe('WhatsApp receipt inbox and delivery log', () => {
  it('tracks acceptance, de-duplicates callbacks and makes processing idempotent', async () => {
    const d = await createDelivery();
    expect(d.status).toBe('accepted');
    await receipt(d, 'delivered');
    await receipt(d, 'delivered');
    expect(await h.owner.whatsAppStatusEvent.count()).toBe(1);
    expect((await row(d)).status).toBe('accepted');
    const [event] = await drain();
    expect((await row(d)).status).toBe('delivered');
    await withMessaging(
      h.services.db,
      (tx) => tx.$executeRaw`SELECT messaging_process_status(${event!.id}::uuid)`,
    );
    expect(await h.owner.auditLog.count({ where: { action: 'messaging.status_updated' } })).toBe(1);
    expect(await drain()).toEqual([]);
    const stored = JSON.stringify(await h.owner.whatsAppStatusEvent.findMany());
    expect(stored).not.toContain('9876543210');
    expect(stored).not.toContain('sensitive');
  });
  it('never regresses delivered/read on late sent or failed receipts', async () => {
    const d = await createDelivery();
    for (const [status, offset] of [
      ['read', 20],
      ['sent', 1],
      ['failed', 30],
      ['delivered', 10],
    ] as const) {
      await receipt(d, status, offset);
      await drain();
    }
    expect((await row(d)).status).toBe('read');
    expect((await row(d)).errorCode).toBeNull();
  });
  it('ignores stale failures and permits stronger delivery evidence after failure', async () => {
    const d = await createDelivery();
    await receipt(d, 'sent', 10);
    await drain();
    await receipt(d, 'failed', 5);
    await drain();
    expect((await row(d)).status).toBe('sent');
    await receipt(d, 'failed', 20);
    await drain();
    expect(await row(d)).toMatchObject({ status: 'failed', errorCode: 131026 });
    await receipt(d, 'delivered', 15);
    await drain();
    expect(await row(d)).toMatchObject({ status: 'delivered', errorCode: null });
  });
  it('handles a callback arriving before the send request records acceptance', async () => {
    vi.spyOn(h.services.otpSender, 'send').mockImplementationOnce(async (_phone, _code, id) => {
      await receipt({ id: id!, providerMessageId: null }, 'delivered');
      await drain();
      return { messageId: `wamid.${id}` };
    });
    const d = await createDelivery();
    expect(d.status).toBe('delivered');
  });
  it('records send failures and retires the challenge', async () => {
    vi.spyOn(h.services.otpSender, 'send').mockRejectedValueOnce(new Error('sensitive failure'));
    const r = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/otp/request',
      payload: { organisation: 'clinic-a', phone: '9876543210' },
    });
    expect(r.statusCode).toBe(503);
    const d = await h.owner.whatsAppDelivery.findFirstOrThrow();
    expect(d.status).toBe('submission_failed');
    expect(
      (await h.owner.otpChallenge.findUniqueOrThrow({ where: { id: d.otpChallengeId! } }))
        .consumedAt,
    ).not.toBeNull();
  });
  it('stores numeric submission diagnostics without exposing provider text', async () => {
    const secret = 'synthetic-token +919876543210 private-provider-details';
    const sender = new MetaWhatsAppOtpSender(
      {
        accessToken: 'synthetic-token',
        phoneNumberId: settings.senderId,
        version: 'v23.0',
        templateName: 'patient_sign_in',
        language: 'en_US',
      },
      vi.fn<typeof fetch>().mockResolvedValue(
        Response.json(
          {
            error: { code: 131030, message: secret },
          },
          { status: 400 },
        ),
      ),
    );
    vi.spyOn(h.services.otpSender, 'send').mockImplementationOnce((...args) =>
      sender.send(...args),
    );
    const response = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/otp/request',
      payload: { organisation: 'clinic-a', phone: '9876543210' },
    });
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toMatch(/131030|private-provider-details|synthetic-token|9876543210/);
    const delivery = await h.owner.whatsAppDelivery.findFirstOrThrow();
    expect(delivery).toMatchObject({ status: 'submission_failed', errorCode: 131030 });
    const challenge = await h.owner.otpChallenge.findUniqueOrThrow({
      where: { id: delivery.otpChallengeId! },
    });
    expect(challenge.consumedAt).not.toBeNull();
    const audit = await h.owner.auditLog.findFirstOrThrow({
      where: { action: 'auth.otp.delivery_failed' },
    });
    expect(audit.metadata).toEqual({
      deliveryStage: 'provider',
      providerCode: 131030,
      providerHttpStatus: 400,
    });
    expect(JSON.stringify(audit)).not.toContain(secret);
    const tokens = await staffLogin(h, 'clinic-a', clinics.a.admin);
    const log = await h.app.inject({ url: '/v1/delivery-log', headers: bearer(tokens) });
    expect(log.statusCode).toBe(200);
    expect(WhatsAppDeliveryList.parse(log.json()).data[0]).toMatchObject({ errorCode: 131030 });
  });

  it('distinguishes acceptance-recording failures and retains confirmed delivery', async () => {
    vi.spyOn(h.services.otpSender, 'send').mockImplementationOnce(async (_phone, _code, id) => {
      await receipt({ id: id!, providerMessageId: null }, 'delivered');
      await drain();
      return { messageId: 'wamid.mismatched' };
    });
    const response = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/otp/request',
      payload: { organisation: 'clinic-a', phone: '9876543210' },
    });
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain('wamid.');
    const delivery = await h.owner.whatsAppDelivery.findFirstOrThrow();
    expect(delivery).toMatchObject({ status: 'delivered', errorCode: null });
    const audit = await h.owner.auditLog.findFirstOrThrow({
      where: { action: 'auth.otp.delivery_failed' },
    });
    expect(audit.metadata).toEqual({ deliveryStage: 'receipt' });
    expect(
      (await h.owner.otpChallenge.findUniqueOrThrow({ where: { id: delivery.otpChallengeId! } }))
        .consumedAt,
    ).not.toBeNull();
  });

  it('keeps the diagnostic function restricted and preserves stronger callback evidence', async () => {
    const delivery = await createDelivery();
    await expect(
      withTenant(
        h.services.db,
        clinics.a.org.id,
        (tx) =>
          tx.$executeRaw`SELECT auth_fail_whatsapp_delivery(${delivery.id}::uuid, now(), 131030)`,
      ),
    ).rejects.toThrow();
    await expect(
      withMessaging(
        h.services.db,
        (tx) =>
          tx.$executeRaw`SELECT auth_fail_whatsapp_delivery(${delivery.id}::uuid, now(), 131030)`,
      ),
    ).rejects.toThrow();
    await expect(
      withAuth(
        h.services.db,
        (tx) => tx.$executeRaw`SELECT auth_fail_whatsapp_delivery(${delivery.id}::uuid, now(), -1)`,
      ),
    ).rejects.toThrow();
    await receipt(delivery, 'read');
    await drain();
    await withAuth(
      h.services.db,
      (tx) =>
        tx.$executeRaw`SELECT auth_fail_whatsapp_delivery(${delivery.id}::uuid, now(), 131030)`,
    );
    expect(await row(delivery)).toMatchObject({ status: 'read', errorCode: null });
    await withAuth(
      h.services.db,
      (tx) => tx.$executeRaw`SELECT auth_fail_whatsapp_delivery(${delivery.id}::uuid, now())`,
    );
    expect(await row(delivery)).toMatchObject({ status: 'read', errorCode: null });
  });

  it('does not associate unknown IDs or mismatched correlation data', async () => {
    const a = await createDelivery();
    const b = await createDelivery('clinic-b');
    await receipt(a, 'delivered', 0, { id: 'wamid.unknown' });
    await receipt(a, 'delivered', 0, { biz_opaque_callback_data: b.id });
    await receipt({ id: randomUUID(), providerMessageId: 'wamid.unknown' }, 'read');
    expect(await h.owner.whatsAppStatusEvent.count()).toBe(0);
    expect((await row(a)).status).toBe('accepted');
    expect((await row(b)).status).toBe('accepted');
  });
  it('keeps logs tenant scoped, admin-only and free of identity/provider IDs', async () => {
    const a = await createDelivery();
    const b = await createDelivery('clinic-b');
    const tokens = await staffLogin(h, 'clinic-a', clinics.a.admin);
    const res = await h.app.inject({ url: '/v1/delivery-log?limit=1', headers: bearer(tokens) });
    expect(res.statusCode, res.body).toBe(200);
    const page = WhatsAppDeliveryList.parse(res.json());
    expect(page.data.map((d) => d.id)).toEqual([a.id]);
    expect(res.body).not.toContain(b.id);
    expect(res.body).not.toContain('9876543210');
    expect(res.body).not.toContain('wamid.');
    expect(
      await withTenant(h.services.db, clinics.a.org.id, (tx) => tx.whatsAppDelivery.count()),
    ).toBe(1);
    const doctor = await staffLogin(h, 'clinic-a', clinics.a.doctor);
    expect(
      (await h.app.inject({ url: '/v1/delivery-log', headers: bearer(doctor) })).statusCode,
    ).toBe(403);
    expect((await h.app.inject({ url: '/v1/delivery-log' })).statusCode).toBe(401);
    expect(
      (await h.app.inject({ url: '/v1/delivery-log?cursor=bad', headers: bearer(tokens) }))
        .statusCode,
    ).toBe(400);
  });
  it('gives callback/auth roles no direct table access or clinical reads', async () => {
    await expect(withMessaging(h.services.db, (tx) => tx.patient.count())).rejects.toThrow();
    await expect(
      withMessaging(h.services.db, (tx) => tx.whatsAppDelivery.count()),
    ).rejects.toThrow();
    await expect(withAuth(h.services.db, (tx) => tx.whatsAppDelivery.count())).rejects.toThrow();
    await expect(
      withTenant(
        h.services.db,
        clinics.a.org.id,
        (tx) => tx.$executeRaw`SELECT messaging_process_status(${randomUUID()}::uuid)`,
      ),
    ).rejects.toThrow();
  });
  it('leases recover after a publishing outage, without losing events', async () => {
    const d = await createDelivery();
    await receipt(d, 'sent');
    const first = await withMessaging(
      h.services.db,
      (tx) => tx.$queryRaw<{ id: string }[]>`SELECT id FROM messaging_claim_status_events()`,
    );
    expect(first).toHaveLength(1);
    expect(
      await withMessaging(
        h.services.db,
        (tx) => tx.$queryRaw`SELECT id FROM messaging_claim_status_events()`,
      ),
    ).toEqual([]);
    await h.owner.whatsAppStatusEvent.update({
      where: { id: first[0]!.id },
      data: { lastEnqueuedAt: new Date(Date.now() - 61_000) },
    });
    expect(await drain()).toEqual(first);
    expect((await row(d)).status).toBe('sent');
  });
});
