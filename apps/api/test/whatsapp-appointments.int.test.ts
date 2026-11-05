import { CURRENT_CONSENT_VERSIONS, type TokenResponse } from '@dhc/contracts';
import { withMessaging, withTenant } from '@dhc/db';
import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  bearer,
  createHarness,
  patientLogin,
  resetDatabase,
  seedTwoClinics,
  staffLogin,
} from './harness';

const h = createHarness();
h.services.appointmentMessagingSender = '1234';
h.services.recordMessagingSender = '1234';
const callback = {
  appSecret: 'synthetic-app-secret',
  verifyToken: 'synthetic-verification-token-32-characters',
  senderId: '1234',
  businessAccountId: '5678',
};
h.services.whatsappWebhook = callback;
let clinics: Awaited<ReturnType<typeof seedTwoClinics>>, admin: TokenResponse;
let clinicId: string,
  typeId: string,
  patientId: string,
  token = 0;
const phone = '+919876543210';
beforeEach(async () => {
  await resetDatabase(h.owner);
  h.clock.ms = Date.now();
  token = 0;
  clinics = await seedTwoClinics(h);
  patientId = clinics.a.patients[0]!.id;
  await h.owner.patient.update({ where: { id: patientId }, data: { phone } });
  clinicId = (
    await h.owner.clinic.create({
      data: { organisationId: clinics.a.org.id, name: 'Synthetic Clinic' },
    })
  ).id;
  typeId = (
    await h.owner.consultationType.create({
      data: {
        organisationId: clinics.a.org.id,
        name: 'Clinic visit',
        mode: 'in_person',
        defaultDurationMin: 15,
        feePaise: 80000,
      },
    })
  ).id;
  admin = await staffLogin(h, 'clinic-a', clinics.a.admin);
});
afterAll(async () => {
  await h.app.close();
  await h.owner.$disconnect();
});
const api = (method: 'GET' | 'PUT' | 'POST', path: string, payload?: object, tokens = admin) =>
  h.app.inject({ method, url: '/v1' + path, headers: bearer(tokens), payload });
async function optIn(enabled = true) {
  const r = await api('PUT', `/patients/${patientId}/whatsapp-preference`, {
    enabled,
    recipientAgreed: true,
  });
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
}
async function appointment(
  status: 'pending' | 'confirmed' | 'checked_in' = 'confirmed',
  hours = 48,
) {
  const startAt = new Date(Date.now() + hours * 3600_000);
  return h.owner.appointment.create({
    data: {
      organisationId: clinics.a.org.id,
      patientId,
      doctorUserId: clinics.a.doctor.userId,
      clinicId,
      consultationTypeId: typeId,
      date: new Date(startAt.toISOString().slice(0, 10) + 'T00:00:00Z'),
      startAt,
      endAt: new Date(startAt.getTime() + 900_000),
      status,
      source: 'front_desk',
      tokenNumber: ++token,
      createdByUserId: clinics.a.doctor.userId,
    },
  });
}
const notices = (id: string) =>
  h.owner.whatsAppDelivery.findMany({ where: { appointmentId: id }, orderBy: { dueAt: 'asc' } });
const claim = () =>
  withMessaging(
    h.services.db,
    (tx) =>
      tx.$queryRaw<{ id: string }[]>`SELECT id FROM messaging_claim_appointment_notices(${'1234'})`,
  );
const begin = (id: string) =>
  withMessaging(
    h.services.db,
    (tx) =>
      tx.$queryRaw<
        Record<string, unknown>[]
      >`SELECT * FROM messaging_begin_appointment_notice(${id}::uuid, ${'1234'})`,
  );

async function stop(messageId: string, at = Math.floor(h.clock.ms / 1000) + 1) {
  const payload = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: callback.businessAccountId,
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: callback.senderId },
              messages: [
                {
                  id: messageId,
                  from: phone.slice(1),
                  timestamp: String(at),
                  type: 'text',
                  text: { body: ' stop ' },
                },
              ],
            },
          },
        ],
      },
    ],
  });
  const signature =
    'sha256=' + createHmac('sha256', callback.appSecret).update(payload).digest('hex');
  const r = await h.app.inject({
    method: 'POST',
    url: '/v1/webhooks/whatsapp',
    payload,
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
  });
  expect(r.statusCode, r.body).toBe(200);
}

describe('appointment message consent and durable outbox', () => {
  it('uses UTC connections even when the temporary database server defaults to IST', async () => {
    const [row] = await h.owner.$queryRaw<
      { zone: string; instant: Date }[]
    >`SELECT current_setting('TimeZone') AS zone, CURRENT_TIMESTAMP AS instant`;
    expect(row!.zone).toBe('UTC');
    expect(Math.abs(row!.instant.getTime() - Date.now())).toBeLessThan(5_000);
  });

  it('does not schedule without opt-in; requires explicit recipient agreement', async () => {
    const a = await appointment();
    expect(await notices(a.id)).toEqual([]);
    expect(
      (await api('PUT', `/patients/${patientId}/whatsapp-preference`, { enabled: true }))
        .statusCode,
    ).toBe(400);
    expect(await optIn()).toMatchObject({ available: true, enabled: true, phoneLast4: '3210' });
    expect(await notices(a.id)).toEqual([]); // Never backfill old confirmations on opt-in.
    const b = await appointment();
    const rows = await notices(b.id);
    expect(rows.map((r) => r.kind)).toEqual(['appointment_confirmation', 'appointment_reminder']);
    expect(rows[1]!.dueAt!.getTime()).toBe(b.startAt.getTime() - 24 * 3600_000);
    expect(rows.every((r) => r.status === 'queued')).toBe(true);
  });
  it('creates confirmation only on confirmation, not on pending bookings or walk-ins', async () => {
    await optIn();
    const pending = await appointment('pending');
    const walkIn = await appointment('checked_in');
    expect(await notices(pending.id)).toEqual([]);
    expect(await notices(walkIn.id)).toEqual([]);
    const r = await api('POST', `/appointments/${pending.id}/actions`, { action: 'confirm' });
    expect(r.statusCode, r.body).toBe(200);
    expect(await notices(pending.id)).toHaveLength(2);
    await h.owner.appointment.update({ where: { id: pending.id }, data: { status: 'confirmed' } });
    expect(await notices(pending.id)).toHaveLength(2);
  });
  it('rolls notification intent back with a failed booking transaction', async () => {
    await optIn();
    const a = await appointment('pending');
    await expect(
      h.owner.$transaction(async (tx) => {
        await tx.appointment.update({ where: { id: a.id }, data: { status: 'confirmed' } });
        throw new Error('synthetic rollback');
      }),
    ).rejects.toThrow();
    expect(await h.owner.whatsAppDelivery.count()).toBe(0);
    expect((await h.owner.appointment.findUniqueOrThrow({ where: { id: a.id } })).status).toBe(
      'pending',
    );
  });
  it('claims due notices only, authorizes a single send and returns no clinical content', async () => {
    await optIn();
    const a = await appointment();
    const [confirmation, reminder] = await notices(a.id);
    expect(await claim()).toEqual([{ id: confirmation!.id }]);
    expect(await begin(reminder!.id)).toEqual([]);
    const competing = await Promise.all([begin(confirmation!.id), begin(confirmation!.id)]);
    expect(competing.map((r) => r.length).sort()).toEqual([0, 1]);
    const payload = competing.flat()[0]!;
    expect(Object.keys(payload).sort()).toEqual([
      'clinic_name',
      'kind',
      'organisation_slug',
      'phone',
      'start_at',
    ]);
    expect(payload.phone).toBe(phone);
    expect(
      (await h.owner.whatsAppDelivery.findUniqueOrThrow({ where: { id: confirmation!.id } }))
        .status,
    ).toBe('sending');
  });
  it('does not generate a second reminder for an appointment booked within 24 hours', async () => {
    await optIn();
    const a = await appointment('confirmed', 2);
    expect((await notices(a.id)).map((r) => r.kind)).toEqual(['appointment_confirmation']);
  });
  it.each(['cancelled', 'rescheduled', 'checked_in', 'no_show'] as const)(
    'skips a queued notice after appointment becomes %s',
    async (status) => {
      await optIn();
      const a = await appointment();
      const [confirmation] = await notices(a.id);
      await h.owner.appointment.update({ where: { id: a.id }, data: { status } });
      expect(
        (await h.owner.whatsAppDelivery.findUniqueOrThrow({ where: { id: confirmation!.id } }))
          .status,
      ).toBe('skipped');
      expect(await begin(confirmation!.id)).toEqual([]);
      expect(
        await h.owner.whatsAppDelivery.findUniqueOrThrow({ where: { id: confirmation!.id } }),
      ).toMatchObject({ status: 'skipped', skipReason: 'appointment_changed' });
    },
  );
  it('does not use queued consent for a changed phone or changed appointment time', async () => {
    await optIn();
    const a = await appointment();
    const [confirmation] = await notices(a.id);
    await h.owner.patient.update({ where: { id: patientId }, data: { phone: '+919876543211' } });
    expect(await begin(confirmation!.id)).toEqual([]);
    expect(
      (await h.owner.whatsAppDelivery.findUniqueOrThrow({ where: { id: confirmation!.id } }))
        .skipReason,
    ).toBe('recipient_changed');
    await h.owner.patient.update({ where: { id: patientId }, data: { phone } });
    const b = await appointment();
    const [other] = await notices(b.id);
    await h.owner.appointment.update({
      where: { id: b.id },
      data: {
        startAt: new Date(b.startAt.getTime() + 3600_000),
        endAt: new Date(b.endAt.getTime() + 3600_000),
      },
    });
    expect(await begin(other!.id)).toEqual([]);
  });
  it('revoke/regrant does not resurrect old notices or duplicate unchanged grants', async () => {
    await optIn();
    const a = await appointment();
    await optIn();
    expect((await h.owner.whatsAppOptIn.findFirstOrThrow()).version).toBe(1);
    await optIn(false);
    await optIn();
    expect((await notices(a.id)).every((d) => d.status === 'skipped')).toBe(true);
    expect(await claim()).toEqual([]);
    const b = await appointment();
    expect(await notices(b.id)).toHaveLength(2);
  });
  it('expired jobs are skipped and crashed sends become uncertain without being retried', async () => {
    await optIn();
    const a = await appointment();
    const [confirmation] = await notices(a.id);
    await begin(confirmation!.id);
    await h.owner.whatsAppDelivery.update({
      where: { id: confirmation!.id },
      data: { attemptedAt: new Date(Date.now() - 180_000) },
    });
    await claim();
    expect(await begin(confirmation!.id)).toEqual([]);
    expect(
      (await h.owner.whatsAppDelivery.findUniqueOrThrow({ where: { id: confirmation!.id } }))
        .status,
    ).toBe('uncertain');
    const b = await appointment();
    const [old] = await notices(b.id);
    await h.owner.whatsAppDelivery.update({
      where: { id: old!.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await claim();
    expect(
      (await h.owner.whatsAppDelivery.findUniqueOrThrow({ where: { id: old!.id } })).status,
    ).toBe('skipped');
  });
  it('STOP is verified, de-duplicated, revokes matching shared-number grants and cancels queued messages', async () => {
    await optIn();
    const a = await appointment();
    await h.owner.whatsAppOptIn.create({
      data: {
        id: randomUUID(),
        organisationId: clinics.b.org.id,
        phone,
        senderPhoneNumberId: '1234',
        enabled: true,
        changedAt: new Date(Date.now() - 1000),
      },
    });
    await h.owner.whatsAppOptIn.create({
      data: {
        id: randomUUID(),
        organisationId: clinics.b.org.id,
        phone,
        senderPhoneNumberId: '9999',
        enabled: true,
        changedAt: new Date(Date.now() - 1000),
      },
    });
    await stop('wamid.stop');
    await stop('wamid.stop');
    expect(await h.owner.whatsAppOptOutEvent.count()).toBe(1);
    expect(
      await h.owner.whatsAppOptIn.count({ where: { senderPhoneNumberId: '1234', enabled: true } }),
    ).toBe(0);
    expect(
      await h.owner.whatsAppOptIn.count({ where: { senderPhoneNumberId: '9999', enabled: true } }),
    ).toBe(1);
    expect((await notices(a.id)).every((r) => r.status === 'skipped')).toBe(true);
    await optIn();
    await stop('wamid.stop');
    expect(
      (
        await h.owner.whatsAppOptIn.findFirstOrThrow({
          where: { organisationId: clinics.a.org.id },
        })
      ).enabled,
    ).toBe(true);
    expect(JSON.stringify(await h.owner.whatsAppOptOutEvent.findMany())).not.toContain(
      '9876543210',
    );
  });
  it.each(['clinic', 'doctor', 'organisation'] as const)(
    'skips notices when the %s is inactive',
    async (target) => {
      await optIn();
      const a = await appointment();
      const [confirmation] = await notices(a.id);
      if (target === 'clinic')
        await h.owner.clinic.update({ where: { id: clinicId }, data: { active: false } });
      if (target === 'doctor')
        await h.owner.user.update({
          where: { id: clinics.a.doctor.userId },
          data: { status: 'disabled' },
        });
      if (target === 'organisation')
        await h.owner.organisation.update({
          where: { id: clinics.a.org.id },
          data: { status: 'suspended' },
        });
      expect(await begin(confirmation!.id)).toEqual([]);
    },
  );
  it('releases a due reminder once and preserves successful callback state after acceptance', async () => {
    await optIn();
    const a = await appointment();
    const [, reminder] = await notices(a.id);
    expect(await begin(reminder!.id)).toEqual([]);
    await h.owner.whatsAppDelivery.update({
      where: { id: reminder!.id },
      data: { dueAt: new Date(Date.now() - 1000), expiresAt: new Date(Date.now() + 900_000) },
    });
    expect(await begin(reminder!.id)).toHaveLength(1);
    const eventId = randomUUID(),
      message = 'wamid.reminder.' + reminder!.id;
    await withMessaging(
      h.services.db,
      (tx) =>
        tx.$queryRaw`SELECT messaging_receive_status(${eventId}::uuid, ${'1234'}, ${message}, ${reminder!.id}::uuid, ${'delivered'}, ${new Date()}, ${null}::integer)`,
    );
    await withMessaging(
      h.services.db,
      (tx) => tx.$executeRaw`SELECT messaging_process_status(${eventId}::uuid)`,
    );
    await withMessaging(
      h.services.db,
      (tx) =>
        tx.$executeRaw`SELECT messaging_finish_appointment_notice(${reminder!.id}::uuid, ${'1234'}, ${'accepted'}, ${message})`,
    );
    expect(
      (await h.owner.whatsAppDelivery.findUniqueOrThrow({ where: { id: reminder!.id } })).status,
    ).toBe('delivered');
    expect(await begin(reminder!.id)).toEqual([]);
  });
  it('cannot enable messaging for a record with no direct phone number', async () => {
    await h.owner.patient.update({ where: { id: patientId }, data: { phone: null } });
    expect((await api('GET', `/patients/${patientId}/whatsapp-preference`)).json().available).toBe(
      false,
    );
    expect(
      (
        await api('PUT', `/patients/${patientId}/whatsapp-preference`, {
          enabled: true,
          recipientAgreed: true,
        })
      ).statusCode,
    ).toBe(409);
  });
  it('does not let a delayed old STOP undo newer consent', async () => {
    await optIn();
    await stop('wamid.old-stop', Math.floor(Date.now() / 1000) - 60);
    expect((await h.owner.whatsAppOptIn.findFirstOrThrow()).enabled).toBe(true);
  });
  it('scopes preferences to organisation, requires patient consents for opt-in, and permits revocation afterwards', async () => {
    expect(
      (await api('GET', `/patients/${clinics.b.patients[0]!.id}/whatsapp-preference`)).statusCode,
    ).toBe(404);
    expect(
      await withTenant(h.services.db, clinics.b.org.id, (tx) => tx.whatsAppOptIn.count()),
    ).toBe(0);
    const tokens = await patientLogin(h, 'clinic-a', phone);
    expect(
      (
        await api(
          'PUT',
          '/portal/whatsapp-preference',
          { enabled: true, recipientAgreed: true },
          tokens,
        )
      ).statusCode,
    ).toBe(403);
    await api(
      'POST',
      '/portal/consents',
      {
        accept: Object.entries(CURRENT_CONSENT_VERSIONS).map(([kind, version]) => ({
          kind,
          version,
        })),
      },
      tokens,
    );
    expect(
      (
        await api(
          'PUT',
          '/portal/whatsapp-preference',
          { enabled: true, recipientAgreed: true },
          tokens,
        )
      ).statusCode,
    ).toBe(200);
    await api('POST', '/portal/consents/health_data/withdraw', {}, tokens);
    expect(
      (await api('PUT', '/portal/whatsapp-preference', { enabled: false }, tokens)).json().enabled,
    ).toBe(false);
    await expect(
      withTenant(
        h.services.db,
        clinics.a.org.id,
        (tx) =>
          tx.$queryRaw`SELECT * FROM messaging_begin_appointment_notice(${randomUUID()}::uuid, ${'1234'})`,
      ),
    ).rejects.toThrow();
    await expect(withMessaging(h.services.db, (tx) => tx.patient.count())).rejects.toThrow();
  });
});

it('STOP revokes appointment and record categories while category identity cannot be changed', async () => {
  await optIn();
  const path = `/patients/${patientId}/whatsapp-record-preference`;
  expect((await api('PUT', path, { enabled: true, recipientAgreed: true })).statusCode).toBe(200);
  const pref = await h.owner.whatsAppOptIn.findFirstOrThrow({ where: { category: 'records' } });
  await expect(
    withTenant(h.services.db, clinics.a.org.id, (tx) =>
      tx.whatsAppOptIn.update({
        where: { id: pref.id },
        data: { category: 'appointments', version: { increment: 1 } },
      }),
    ),
  ).rejects.toThrow();
  await stop('wamid.both-categories');
  expect((await api('GET', path)).json().enabled).toBe(false);
  expect((await api('GET', `/patients/${patientId}/whatsapp-preference`)).json().enabled).toBe(
    false,
  );
});
