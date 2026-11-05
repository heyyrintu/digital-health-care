import { createHmac, randomUUID } from 'node:crypto';
import { beforeEach, afterAll, it, expect, vi } from 'vitest';
import { withTenant } from '@dhc/db';
import type { TokenResponse } from '@dhc/contracts';
import {
  createHarness,
  resetDatabase,
  seedTwoClinics,
  staffLogin,
  addStaff,
  bearer,
  patientLogin,
} from './harness';
import type { ProviderTemplate, InboxGateway } from '../src/modules/whatsapp-inbox/gateway';
import { dispatchInbox } from '../src/modules/whatsapp-inbox/dispatch';
import { InboxService } from '../src/modules/whatsapp-inbox/service';
const h = createHarness(),
  secret = 'synthetic-inbox-app-secret';
h.services.whatsappWebhook = {
  appSecret: secret,
  verifyToken: 'synthetic-inbox-verification-token-32',
  senderId: '1234',
  businessAccountId: '5678',
};
const send = vi.fn<InboxGateway['send']>(async () => ({
  state: 'accepted' as const,
  messageId: 'wamid.out.' + randomUUID(),
}));
let providerTemplates: ProviderTemplate[],
  clinics: Awaited<ReturnType<typeof seedTwoClinics>>,
  admin: TokenResponse,
  desk: TokenResponse,
  doctor: TokenResponse,
  other: TokenResponse;
let testIp = 0;
const call = (method: string, path: string, body?: unknown, token = desk) =>
  h.app.inject({
    method: method as 'GET',
    url: '/v1' + path,
    headers: bearer(token),
    remoteAddress: '10.17.0.' + testIp,
    payload: body as object,
  });
const stamp = () => String(Math.floor(h.clock.ms / 1000));
async function hook(value: object, sender = '111', business = '5678', valid = true) {
  const payload = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: business,
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: sender },
              ...value,
            },
          },
        ],
      },
    ],
  });
  return h.app.inject({
    method: 'POST',
    url: '/v1/webhooks/whatsapp',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': valid
        ? 'sha256=' + createHmac('sha256', secret).update(payload).digest('hex')
        : 'sha256=' + '0'.repeat(64),
    },
    payload,
  });
}
async function incoming(
  text = 'Please help with my appointment',
  sender = '111',
  id = 'wamid.in.' + randomUUID(),
  timestamp = stamp(),
) {
  const r = await hook(
    { messages: [{ id, from: '919876543210', timestamp, type: 'text', text: { body: text } }] },
    sender,
  );
  expect(r.statusCode, r.body).toBe(200);
  return h.owner.inboxThread.findFirstOrThrow({ where: { senderId: sender } });
}
async function enable() {
  expect((await call('POST', '/inbox/templates/sync', undefined, admin)).statusCode).toBe(200);
  const r = await h.owner.inboxTemplate.findFirstOrThrow({ where: { senderId: '111' } });
  const enabled = await call(
    'POST',
    `/inbox/templates/${r.id}`,
    { revision: r.revision, enabled: true },
    admin,
  );
  expect(enabled.statusCode, enabled.body).toBe(200);
  return enabled.json();
}
async function consent(t: { id: string; revision: number }) {
  const r = await call('POST', `/inbox/threads/${t.id}/consent`, {
    revision: t.revision,
    enabled: true,
    recipientAgreed: true,
    source: 'written',
  });
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
}
beforeEach(async () => {
  testIp++;
  vi.restoreAllMocks();
  h.clock.ms = Date.UTC(2026, 9, 6, 4, 30);
  await resetDatabase(h.owner);
  clinics = await seedTwoClinics(h);
  admin = await staffLogin(h, 'clinic-a', clinics.a.admin);
  doctor = await staffLogin(h, 'clinic-a', clinics.a.doctor);
  desk = await staffLogin(
    h,
    'clinic-a',
    await addStaff(h, clinics.a.org.id, 'front_desk', 'desk@clinic-a.test'),
  );
  other = await staffLogin(h, 'clinic-b', clinics.b.admin);
  providerTemplates = [
    {
      id: '9001',
      name: 'clinic_service',
      language: 'en',
      category: 'UTILITY',
      status: 'APPROVED',
      components: [{ type: 'BODY', text: 'Please contact the clinic about your request.' }],
    },
  ];
  send.mockReset();
  send.mockImplementation(async () => ({
    state: 'accepted',
    messageId: 'wamid.out.' + randomUUID(),
  }));
  h.services.whatsappInbox = {
    channels: [
      { organisationId: clinics.a.org.id, senderId: '111', businessId: '5678' },
      { organisationId: clinics.b.org.id, senderId: '222', businessId: '5678' },
    ],
    gateway: { send, templates: async () => providerTemplates },
  };
});
afterAll(async () => {
  await h.app.close();
  await h.owner.$disconnect();
});
it('routes signed incoming messages by an immutable clinic sender, encrypts phone/text and deduplicates retries', async () => {
  const id = 'wamid.unique',
    a = await incoming('PRIVATE incoming message', '111', id);
  await incoming('PRIVATE incoming message', '111', id);
  await incoming('Other clinic contact', '222', 'wamid.b');
  expect(await h.owner.inboxMessage.count()).toBe(2);
  expect((await h.owner.inboxThread.findUniqueOrThrow({ where: { id: a.id } })).unread).toBe(1);
  expect(JSON.stringify(a)).not.toContain('+919876543210');
  expect(h.services.cipher.decrypt(a.phoneCipher)).toBe('+919876543210');
  const list = await call('GET', '/inbox');
  expect(list.statusCode, list.body).toBe(200);
  expect(list.json().data).toHaveLength(1);
  const msgs = await call('GET', `/inbox/threads/${a.id}/messages`);
  expect(msgs.body).toContain('PRIVATE incoming message');
  expect((await call('GET', `/inbox/threads/${a.id}/messages`, undefined, other)).statusCode).toBe(
    404,
  );
  const bad = await hook(
    {
      messages: [
        {
          id: 'fake',
          from: '919876543210',
          timestamp: stamp(),
          type: 'text',
          text: { body: 'fake' },
        },
      ],
    },
    '111',
    '5678',
    false,
  );
  expect(bad.statusCode).toBe(401);
  expect(await h.owner.inboxMessage.count()).toBe(2);
  expect((await hook({ messages: [] }, 'unknown')).statusCode).toBe(200);
});
it('does not route an incoming message into a different clinic if an operator remaps an already-bound sender', async () => {
  await incoming();
  h.services.whatsappInbox!.channels = [
    { organisationId: clinics.b.org.id, senderId: '111', businessId: '5678' },
  ];
  const r = await hook({
    messages: [
      {
        id: 'remap',
        from: '919876543210',
        timestamp: stamp(),
        type: 'text',
        text: { body: 'Must not reroute' },
      },
    ],
  });
  expect(r.statusCode, r.body).toBe(503);
  expect(await h.owner.inboxMessage.count()).toBe(1);
});
it('sends one authorized text reply, recovers the same UUID and rejects changed payloads without duplicates', async () => {
  const t = await incoming(),
    id = randomUUID(),
    body = { id, text: 'Clinic reply' };
  const r = await call('POST', `/inbox/threads/${t.id}/messages`, body);
  expect(r.statusCode, r.body).toBe(200);
  expect(r.json().state).toBe('accepted');
  expect(send).toHaveBeenCalledTimes(1);
  expect((await call('POST', `/inbox/threads/${t.id}/messages`, body)).statusCode).toBe(200);
  expect(send).toHaveBeenCalledTimes(1);
  expect(
    (await call('POST', `/inbox/threads/${t.id}/messages`, { id, text: 'Changed reply' }))
      .statusCode,
  ).toBe(409);
  const logs = await h.owner.auditLog.findMany({ where: { action: { startsWith: 'inbox.' } } });
  expect(JSON.stringify(logs)).not.toContain('Clinic reply');
});
it('checks the reply window at queueing and again before dispatch; never substitutes a template automatically', async () => {
  const t = await incoming(),
    user = await h.owner.user.findUniqueOrThrow({ where: { email: 'desk@clinic-a.test' } }),
    actor = { organisationId: clinics.a.org.id, userId: user.id, role: 'front_desk' as const },
    id = randomUUID();
  await new InboxService(h.services).enqueue(
    { id: 'test', ip: '127.0.0.1', headers: {} } as never,
    actor,
    t.id,
    { id, text: 'Will expire' },
  );
  h.clock.advance(86400);
  await dispatchInbox(h.services, clinics.a.org.id, id);
  expect(send).not.toHaveBeenCalled();
  expect((await h.owner.inboxMessage.findUniqueOrThrow({ where: { id } })).state).toBe('skipped');
  desk = await staffLogin(h, 'clinic-a', {
    userId: user.id,
    email: user.email!,
    totpSecret: h.services.cipher.decrypt(user.mfaSecret!),
  });
  expect(
    (
      await call('POST', `/inbox/threads/${t.id}/messages`, {
        id: randomUUID(),
        text: 'Late reply',
      })
    ).statusCode,
  ).toBe(409);
});
it('requires provider-approved supported enabled templates and explicit consent; changed, missing and stale templates are disabled', async () => {
  const t = await incoming(),
    template = await enable();
  expect(
    (
      await call('POST', `/inbox/threads/${t.id}/messages`, {
        id: randomUUID(),
        templateId: template.id,
      })
    ).statusCode,
  ).toBe(409);
  await consent(t);
  await h.owner.inboxThread.update({
    where: { id: t.id },
    data: { lastInboundAt: new Date(h.clock.ms - 25 * 3600000) },
  });
  const r = await call('POST', `/inbox/threads/${t.id}/messages`, {
    id: randomUUID(),
    templateId: template.id,
  });
  expect(r.statusCode, r.body).toBe(200);
  expect(send.mock.calls[0]?.[1]).toMatchObject({
    template: { name: 'clinic_service', language: 'en' },
  });
  providerTemplates[0]!.components[0]!.text = 'Changed provider wording';
  expect((await call('POST', '/inbox/templates/sync', undefined, admin)).statusCode).toBe(200);
  expect(
    (await h.owner.inboxTemplate.findUniqueOrThrow({ where: { id: template.id } })).enabled,
  ).toBe(false);
  providerTemplates = [];
  await call('POST', '/inbox/templates/sync', undefined, admin);
  expect(
    (await h.owner.inboxTemplate.findUniqueOrThrow({ where: { id: template.id } })).providerStatus,
  ).toBe('MISSING');
});
it('does not turn marketing, authentication, variables or attachments into supported service templates', async () => {
  providerTemplates = [
    { ...providerTemplates[0]!, category: 'MARKETING' },
    {
      ...providerTemplates[0]!,
      id: '9002',
      name: 'dynamic',
      components: [{ type: 'BODY', text: 'Hello {{1}}' }],
    },
    {
      ...providerTemplates[0]!,
      id: '9003',
      name: 'media',
      components: [
        { type: 'HEADER', format: 'IMAGE' } as never,
        { type: 'BODY', text: 'See attached' },
      ],
    },
  ];
  const sync = await call('POST', '/inbox/templates/sync', undefined, admin);
  expect(sync.statusCode, sync.body).toBe(200);
  for (const t of sync.json().data) {
    expect(t.supported).toBe(false);
    expect(
      (
        await call(
          'POST',
          `/inbox/templates/${t.id}`,
          { revision: t.revision, enabled: true },
          admin,
        )
      ).statusCode,
    ).toBe(409);
  }
  expect((await call('POST', '/inbox/templates/sync')).statusCode).toBe(403);
});
it('STOP blocks queued and new sends; inbound messages never silently restore template consent', async () => {
  let t = await incoming();
  const preference = await h.owner.whatsAppOptIn.create({
    data: {
      id: randomUUID(),
      organisationId: clinics.a.org.id,
      phone: '+919876543210',
      senderPhoneNumberId: '111',
      category: 'appointments',
      enabled: true,
      changedAt: new Date(h.clock.ms - 1000),
    },
  });
  t = await consent(t);
  await incoming('STOP' + ' '.repeat(100));
  expect(
    (await h.owner.whatsAppOptIn.findUniqueOrThrow({ where: { id: preference.id } })).enabled,
  ).toBe(false);
  t = await h.owner.inboxThread.findUniqueOrThrow({ where: { id: t.id } });
  expect(t.stoppedAt).not.toBeNull();
  expect(t.optedInAt).toBeNull();
  expect(
    (
      await call('POST', `/inbox/threads/${t.id}/messages`, {
        id: randomUUID(),
        text: 'Must not send',
      })
    ).statusCode,
  ).toBe(409);
  await incoming('Another question');
  expect(
    (await h.owner.inboxThread.findUniqueOrThrow({ where: { id: t.id } })).stoppedAt,
  ).not.toBeNull();
  t = await h.owner.inboxThread.findUniqueOrThrow({ where: { id: t.id } });
  h.clock.advance(1);
  const granted = await consent(t);
  expect(granted.stopped).toBe(false);
});
it('keeps clinical handoffs private: admins get metadata; only the assigned doctor can read/release the conversation', async () => {
  const t = await incoming('Private incoming details');
  expect((await call('GET', `/inbox/threads/${t.id}/messages`, undefined, admin)).statusCode).toBe(
    403,
  );
  expect((await call('GET', '/inbox', undefined, admin)).body).not.toContain('+919876543210');
  const assigned = await call('POST', `/inbox/threads/${t.id}/assign`, {
    revision: t.revision,
    doctorId: clinics.a.doctor.userId,
  });
  expect(assigned.statusCode, assigned.body).toBe(200);
  expect(assigned.json().canRead).toBe(false);
  expect((await call('GET', `/inbox/threads/${t.id}/messages`)).statusCode).toBe(403);
  expect((await call('GET', `/inbox/threads/${t.id}/messages`, undefined, doctor)).body).toContain(
    'Private incoming details',
  );
  expect(
    (
      await call(
        'POST',
        `/inbox/threads/${t.id}/assign`,
        { revision: assigned.json().revision, doctorId: null },
        admin,
      )
    ).statusCode,
  ).toBe(403);
  const release = await call(
    'POST',
    `/inbox/threads/${t.id}/assign`,
    { revision: assigned.json().revision, doctorId: null },
    doctor,
  );
  expect(release.statusCode, release.body).toBe(200);
  expect((await call('GET', `/inbox/threads/${t.id}/messages`, undefined, doctor)).statusCode).toBe(
    404,
  );
});
it('never automatically retries an uncertain provider result; callbacks bind early and cannot regress delivered/read', async () => {
  const t = await incoming(),
    id = randomUUID();
  send.mockImplementationOnce(async () => ({ state: 'uncertain' }) as never);
  const r = await call('POST', `/inbox/threads/${t.id}/messages`, { id, text: 'Uncertain reply' });
  expect(r.statusCode, r.body).toBe(200);
  expect(r.json().state).toBe('uncertain');
  await call('POST', `/inbox/threads/${t.id}/messages`, { id, text: 'Uncertain reply' });
  expect(send).toHaveBeenCalledTimes(1);
  const status = async (state: string, message = 'wamid.callback') =>
    hook({
      statuses: [{ id: message, status: state, timestamp: stamp(), biz_opaque_callback_data: id }],
    });
  expect((await status('read')).statusCode).toBe(200);
  expect((await h.owner.inboxMessage.findUniqueOrThrow({ where: { id } })).state).toBe('read');
  await status('failed');
  expect((await h.owner.inboxMessage.findUniqueOrThrow({ where: { id } })).state).toBe('read');
  await status('read', 'wamid.wrong');
  expect((await h.owner.inboxMessage.findUniqueOrThrow({ where: { id } })).providerId).toBe(
    'wamid.callback',
  );
});
it('retains unsupported attachments as metadata only and enforces immutable message content and clinic foreign keys', async () => {
  const r = await hook({
    messages: [
      {
        id: 'wamid.image',
        from: '919876543210',
        timestamp: stamp(),
        type: 'image',
        image: { id: 'SECRET-MEDIA-ID', caption: 'Sensitive caption' },
      },
    ],
  });
  expect(r.statusCode, r.body).toBe(200);
  const m = await h.owner.inboxMessage.findFirstOrThrow();
  expect(m.kind).toBe('unsupported');
  expect(h.services.cipher.decrypt(m.bodyCipher)).toBe('');
  expect(JSON.stringify(m)).not.toContain('SECRET-MEDIA-ID');
  await expect(
    withTenant(h.services.db, clinics.a.org.id, (tx) =>
      tx.inboxMessage.update({ where: { id: m.id }, data: { bodyCipher: 'changed' } }),
    ),
  ).rejects.toThrow();
  const p = await patientLogin(h, 'clinic-a', '9876543210');
  expect((await call('GET', '/inbox', undefined, p)).statusCode).toBe(403);
});
it('cancels an authorized-but-queued reply when STOP or handoff arrives before send authorization', async () => {
  const t = await incoming(),
    user = await h.owner.user.findUniqueOrThrow({ where: { email: 'desk@clinic-a.test' } }),
    actor = { organisationId: clinics.a.org.id, userId: user.id, role: 'front_desk' as const },
    service = new InboxService(h.services),
    req = { id: 'queue-check', ip: '127.0.0.1', headers: {} } as never;
  const first = randomUUID();
  await service.enqueue(req, actor, t.id, { id: first, text: 'Do not send after STOP' });
  await incoming('STOP');
  await dispatchInbox(h.services, clinics.a.org.id, first);
  expect(send).not.toHaveBeenCalled();
  expect((await h.owner.inboxMessage.findUniqueOrThrow({ where: { id: first } })).state).toBe(
    'skipped',
  );
  h.clock.advance(1);
  const current = await h.owner.inboxThread.findUniqueOrThrow({ where: { id: t.id } });
  await consent(current);
  const second = randomUUID();
  await service.enqueue(req, actor, t.id, { id: second, text: 'Do not send after handoff' });
  const thread = await h.owner.inboxThread.findUniqueOrThrow({ where: { id: t.id } });
  await call('POST', `/inbox/threads/${t.id}/assign`, {
    revision: thread.revision,
    doctorId: clinics.a.doctor.userId,
  });
  await dispatchInbox(h.services, clinics.a.org.id, second);
  expect(send).not.toHaveBeenCalled();
  expect((await h.owner.inboxMessage.findUniqueOrThrow({ where: { id: second } })).state).toBe(
    'skipped',
  );
});
it('revokes the matching inbox consent and pending replies when the verified patient closes this clinic account', async () => {
  const t = await incoming();
  await consent(t);
  const person = clinics.a.patients[0]!;
  await h.owner.patient.update({ where: { id: person.id }, data: { phone: '+919876543210' } });
  const patient = await patientLogin(h, 'clinic-a', '9876543210');
  const key = randomUUID();
  const started = await call('POST', '/data-rights/closure', { id: key }, patient);
  expect(started.statusCode, started.body).toBe(200);
  const code = h.sentCodes.at(-1)!.code;
  const closed = await call(
    'POST',
    `/data-rights/closure/${key}/verify`,
    { code, confirmed: true },
    patient,
  );
  expect(closed.statusCode, closed.body).toBe(200);
  const row = await h.owner.inboxThread.findUniqueOrThrow({ where: { id: t.id } });
  expect(row.optedInAt).toBeNull();
  expect(row.stoppedAt).not.toBeNull();
});
it('does not extend the service window with a future provider timestamp or allow a stale cached template', async () => {
  const t = await incoming(
    'Slight clock skew',
    '111',
    'future-event',
    String(Math.floor(h.clock.ms / 1000) + 120),
  );
  expect(t.lastInboundAt.getTime()).toBeLessThanOrEqual(h.clock.ms);
  const template = await enable();
  await consent(t);
  h.clock.advance(3601);
  desk = await staffLogin(
    h,
    'clinic-a',
    await addStaff(h, clinics.a.org.id, 'front_desk', 'later@clinic-a.test'),
  );
  expect(
    (
      await call('POST', `/inbox/threads/${t.id}/messages`, {
        id: randomUUID(),
        templateId: template.id,
      })
    ).statusCode,
  ).toBe(409);
  expect(send).not.toHaveBeenCalled();
});
it('retains a signed read receipt received before the provider HTTP response is recorded', async () => {
  const t = await incoming(),
    id = randomUUID();
  send.mockImplementationOnce(async (_channel, body) => {
    const receipt = await hook({
      statuses: [
        {
          id: 'wamid.early',
          status: 'read',
          timestamp: stamp(),
          biz_opaque_callback_data: body.id,
        },
      ],
    });
    expect(receipt.statusCode, receipt.body).toBe(200);
    return { state: 'accepted', messageId: 'wamid.early' };
  });
  const r = await call('POST', `/inbox/threads/${t.id}/messages`, {
    id,
    text: 'Early callback test',
  });
  expect(r.statusCode, r.body).toBe(200);
  expect(r.json().state).toBe('read');
  expect((await h.owner.inboxMessage.findUniqueOrThrow({ where: { id } })).providerId).toBe(
    'wamid.early',
  );
  expect(send).toHaveBeenCalledTimes(1);
});
it('database guards reject cross-clinic doctor, template and outgoing-staff references', async () => {
  const t = await incoming();
  await incoming('Other clinic', '222');
  await expect(
    withTenant(h.services.db, clinics.a.org.id, (tx) =>
      tx.inboxThread.update({
        where: { id: t.id },
        data: { assignedDoctorId: clinics.b.doctor.userId },
      }),
    ),
  ).rejects.toThrow();
  const template = await h.owner.inboxTemplate.create({
    data: {
      id: randomUUID(),
      organisationId: clinics.b.org.id,
      senderId: '222',
      providerId: 'foreign-template',
      name: 'service',
      language: 'en',
      category: 'UTILITY',
      providerStatus: 'APPROVED',
      bodyCipher: h.services.cipher.encrypt('Generic service text'),
      contentHash: 'hash',
      supported: true,
      enabled: true,
      verifiedAt: h.services.now(),
    },
  });
  const deskUser = await h.owner.user.findUniqueOrThrow({ where: { email: 'desk@clinic-a.test' } }),
    data = {
      organisationId: clinics.a.org.id,
      threadId: t.id,
      senderId: '111',
      direction: 'outbound',
      kind: 'template',
      bodyCipher: h.services.cipher.encrypt('Generic service text'),
      state: 'queued',
      occurredAt: h.services.now(),
      createdAt: h.services.now(),
      statusAt: h.services.now(),
      sentByUserId: deskUser.id,
      sentByRole: 'front_desk',
      templateId: template.id,
    };
  await expect(
    withTenant(h.services.db, clinics.a.org.id, (tx) =>
      tx.inboxMessage.create({ data: { ...data, id: randomUUID() } }),
    ),
  ).rejects.toThrow();
  await expect(
    withTenant(h.services.db, clinics.a.org.id, (tx) =>
      tx.inboxMessage.create({
        data: {
          ...data,
          id: randomUUID(),
          templateId: null,
          sentByUserId: clinics.b.doctor.userId,
          sentByRole: 'doctor',
        },
      }),
    ),
  ).rejects.toThrow();
});
