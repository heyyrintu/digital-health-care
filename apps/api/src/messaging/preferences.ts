const senderFor = (s: Services, category: 'appointments' | 'records' | 'payments') =>
  category === 'payments'
    ? s.paymentMessagingSender
    : category === 'records'
      ? s.recordMessagingSender
      : (s.appointmentMessagingSender ?? s.operationMessagingSender);
import { SetWhatsAppPreference, STAFF_ROLES, WhatsAppPreference } from '@dhc/contracts';
import { withTenant, type Tx } from '@dhc/db';
import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '../errors';
import { authOf, authenticate, requireRole } from '../plugins/authenticate';
import type { Services } from '../services';
import { writeAudit } from '../modules/audit/write';
import { accountPhone } from '../modules/portal/account';
import { PortalService } from '../modules/portal/service';
import { assertNotMerged } from '../modules/patients/merged';

async function preference(
  tx: Tx,
  s: Services,
  phone: string | null,
  category: 'appointments' | 'records' | 'payments',
) {
  const row = phone
    ? await tx.whatsAppOptIn.findFirst({
        where: {
          phone,
          category,
          ...(senderFor(s, category)
            ? {
                senderPhoneNumberId: senderFor(s, category),
              }
            : { enabled: true }),
        },
        orderBy: { changedAt: 'desc' },
      })
    : null;
  return WhatsAppPreference.parse({
    available: !!senderFor(s, category) && !!phone,
    enabled: row?.enabled ?? false,
    phoneLast4: phone?.slice(-4) ?? null,
    updatedAt: row?.changedAt.toISOString() ?? null,
  });
}

async function save(
  tx: Tx,
  s: Services,
  request: FastifyRequest,
  phone: string | null,
  category: 'appointments' | 'records' | 'payments',
) {
  const body = SetWhatsAppPreference.parse(request.body);
  const actor = authOf(request);
  if (body.enabled && (!senderFor(s, category) || !phone)) {
    throw new AppError(
      409,
      'BUSINESS_RULE',
      'WhatsApp messages in this category are not available for this number yet.',
    );
  }
  if (phone) {
    // Serialize grants/revokes for this organisation and number, including the no-row case.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${actor.organisationId + ':' + phone}, 0))`;
    const rows = await tx.whatsAppOptIn.findMany({ where: { phone, category } });
    if (body.enabled) {
      const current = rows.find((r) => r.senderPhoneNumberId === senderFor(s, category));
      if (!current?.enabled) {
        const row = await tx.whatsAppOptIn.upsert({
          where: {
            organisationId_phone_senderPhoneNumberId_category: {
              organisationId: actor.organisationId,
              phone,
              category,
              senderPhoneNumberId: senderFor(s, category)!,
            },
          },
          create: {
            id: randomUUID(),
            organisationId: actor.organisationId,
            phone,
            category,
            senderPhoneNumberId: senderFor(s, category)!,
            enabled: true,
            changedAt: s.now(),
            changedByUserId: actor.userId,
          },
          update: {
            enabled: true,
            version: { increment: 1 },
            changedAt: s.now(),
            changedByUserId: actor.userId,
          },
        });
        await writeAudit(tx, request, {
          action: 'messaging.preference_changed',
          organisationId: actor.organisationId,
          actorUserId: actor.userId,
          entityType: 'whatsapp_opt_in',
          entityId: row.id,
          metadata: {
            enabled: true,
            category,
            source: actor.role === 'patient' ? 'patient_portal' : 'staff_recorded',
          },
        });
      }
    } else {
      for (const row of rows.filter((r) => r.enabled)) {
        await tx.whatsAppOptIn.update({
          where: { id: row.id },
          data: {
            enabled: false,
            version: { increment: 1 },
            changedAt: s.now(),
            changedByUserId: actor.userId,
          },
        });
        await writeAudit(tx, request, {
          action: 'messaging.preference_changed',
          organisationId: actor.organisationId,
          actorUserId: actor.userId,
          entityType: 'whatsapp_opt_in',
          entityId: row.id,
          metadata: {
            enabled: false,
            category,
            source: actor.role === 'patient' ? 'patient_portal' : 'staff_recorded',
          },
        });
      }
    }
  }
  return preference(tx, s, phone, category);
}

export const whatsappPreferenceRoutes: FastifyPluginAsync<{ services: Services }> = async (
  app,
  { services },
) => {
  const staff = { preHandler: [authenticate(services), requireRole(...STAFF_ROLES)] };
  const patient = { preHandler: [authenticate(services), requireRole('patient')] };
  const patientPhone = async (tx: Tx, id: string) => {
    const row = await tx.patient.findUnique({
      where: { id },
      select: { phone: true, mergedIntoId: true },
    });
    if (!row) throw new AppError(404, 'NOT_FOUND', 'Not found.');
    assertNotMerged(row);
    return row.phone;
  };
  for (const category of ['appointments', 'records', 'payments'] as const) {
    const suffix =
      category === 'payments'
        ? 'whatsapp-payment-preference'
        : category === 'records'
          ? 'whatsapp-record-preference'
          : 'whatsapp-preference';
    app.get(`/patients/:id/${suffix}`, staff, async (request) => {
      const { id } = z.object({ id: z.uuid() }).parse(request.params);
      return withTenant(services.db, authOf(request).organisationId, async (tx) =>
        preference(tx, services, await patientPhone(tx, id), category),
      );
    });
    app.put(`/patients/:id/${suffix}`, staff, async (request) => {
      const { id } = z.object({ id: z.uuid() }).parse(request.params);
      return withTenant(services.db, authOf(request).organisationId, async (tx) =>
        save(tx, services, request, await patientPhone(tx, id), category),
      );
    });
    app.get(`/portal/${suffix}`, patient, async (request) => {
      const actor = authOf(request),
        phone = await accountPhone(services, actor.userId);
      return withTenant(services.db, actor.organisationId, (tx) =>
        preference(tx, services, phone, category),
      );
    });
    app.put(`/portal/${suffix}`, patient, async (request) => {
      const actor = authOf(request),
        phone = await accountPhone(services, actor.userId);
      const body = SetWhatsAppPreference.parse(request.body);
      return withTenant(services.db, actor.organisationId, async (tx) => {
        // Revoking optional messages remains possible after health consent withdrawal.
        if (body.enabled) await new PortalService(services).requireConsents(tx, actor);
        return save(tx, services, request, phone, category);
      });
    });
  }
};
