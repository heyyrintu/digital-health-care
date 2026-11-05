import { receiveInbox } from '../modules/whatsapp-inbox/incoming';
import { receiveInboxStatus } from '../modules/whatsapp-inbox/dispatch';
import { withMessaging } from '@dhc/db';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { AppError } from '../errors';
import type { Services } from '../services';

export const ReceiptStatus = z.enum(['sent', 'delivered', 'read', 'failed']);
const Status = z.object({
  id: z.string().min(1).max(512),
  status: z.string().max(32),
  timestamp: z.string().regex(/^\d{1,12}$/),
  biz_opaque_callback_data: z.string().max(512).optional(),
  errors: z
    .array(z.object({ code: z.number().int().min(0).max(2_147_483_647) }))
    .max(10)
    .optional(),
});
const Envelope = z.object({
  object: z.literal('whatsapp_business_account'),
  entry: z
    .array(
      z.object({
        id: z.string().max(64),
        changes: z.array(z.object({ field: z.string(), value: z.unknown() })).max(100),
      }),
    )
    .max(100),
});
const Value = z.object({
  messaging_product: z.literal('whatsapp'),
  metadata: z.object({ phone_number_id: z.string() }),
  statuses: z.array(Status).max(100).optional(),
  messages: z.array(z.unknown()).max(100).optional(),
});

/** Only STOP is retained as a hashed event ID; all other incoming text is discarded. */
export function stopRequests(body: unknown, senderId: string, businessAccountId: string) {
  const result = [];
  const Stop = z.object({
    id: z.string().min(1).max(512),
    from: z.string().regex(/^91[6-9]\d{9}$/),
    timestamp: z.string().regex(/^\d{1,12}$/),
    type: z.literal('text'),
    text: z.object({ body: z.string().max(8192) }),
  });
  for (const entry of Envelope.parse(body).entry) {
    if (entry.id !== businessAccountId) continue;
    for (const change of entry.changes) {
      if (change.field !== 'messages') continue;
      const value = Value.parse(change.value);
      if (value.metadata.phone_number_id !== senderId) continue;
      for (const raw of value.messages ?? []) {
        const parsed = Stop.safeParse(raw);
        if (!parsed.success || parsed.data.text.body.trim().toUpperCase() !== 'STOP') continue;
        const at = new Date(Number(parsed.data.timestamp) * 1000);
        if (!Number.isFinite(at.getTime()) || at.getUTCFullYear() > 9999) continue;
        result.push({
          eventId: createHash('sha256')
            .update(senderId + ':' + parsed.data.id)
            .digest('hex'),
          phone: '+' + parsed.data.from,
          at,
        });
        if (result.length > 100) throw new AppError(400, 'VALIDATION_FAILED', 'Too many opt-outs.');
      }
    }
  }
  return result;
}

export function validSignature(raw: Buffer, signature: unknown, secret: string): boolean {
  if (typeof signature !== 'string' || !/^sha256=[a-fA-F0-9]{64}$/.test(signature)) return false;
  const expected = createHmac('sha256', secret).update(raw).digest();
  return timingSafeEqual(expected, Buffer.from(signature.slice(7), 'hex'));
}

export function statusReceipts(body: unknown, senderId: string, businessAccountId: string) {
  const receipts = [];
  for (const entry of Envelope.parse(body).entry) {
    if (entry.id !== businessAccountId) continue;
    for (const change of entry.changes) {
      if (change.field !== 'messages') continue;
      const value = Value.parse(change.value);
      if (value.metadata.phone_number_id !== senderId) continue;
      for (const status of value.statuses ?? []) {
        const parsedStatus = ReceiptStatus.safeParse(status.status);
        if (!parsedStatus.success) continue;
        const occurredAt = new Date(Number(status.timestamp) * 1000);
        if (!Number.isFinite(occurredAt.getTime()) || occurredAt.getUTCFullYear() > 9999) {
          throw new AppError(400, 'VALIDATION_FAILED', 'Invalid status timestamp.');
        }
        const correlation = z.uuid().safeParse(status.biz_opaque_callback_data);
        receipts.push({
          messageId: status.id,
          correlationId: correlation.success ? correlation.data : null,
          status: parsedStatus.data,
          occurredAt,
          errorCode: status.errors?.[0]?.code ?? null,
        });
        if (receipts.length > 100)
          throw new AppError(400, 'VALIDATION_FAILED', 'Too many statuses.');
      }
    }
  }
  return receipts;
}

/** Scoped raw-body parser: other API routes retain their ordinary JSON parser. */
export const whatsappWebhookRoutes: FastifyPluginAsync<{ services: Services }> = async (
  app,
  { services },
) => {
  const config = services.whatsappWebhook;
  if (!config) return;
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) =>
    done(null, body),
  );

  // The verification token is in the URL: suppress automatic request/response logs here.
  app.get('/webhooks/whatsapp', { logLevel: 'silent' }, async (request, reply) => {
    const q = z
      .object({
        'hub.mode': z.literal('subscribe'),
        'hub.verify_token': z.string().max(512),
        'hub.challenge': z.string().regex(/^\d{1,128}$/),
      })
      .safeParse(request.query);
    if (!q.success) throw new AppError(403, 'FORBIDDEN', 'Webhook verification failed.');
    const digest = (s: string) => createHash('sha256').update(s).digest();
    if (!timingSafeEqual(digest(q.data['hub.verify_token']), digest(config.verifyToken))) {
      throw new AppError(403, 'FORBIDDEN', 'Webhook verification failed.');
    }
    return reply.type('text/plain').send(q.data['hub.challenge']);
  });

  app.post('/webhooks/whatsapp', { bodyLimit: 256 * 1024 }, async (request, reply) => {
    const raw = request.body;
    if (
      !Buffer.isBuffer(raw) ||
      !validSignature(raw, request.headers['x-hub-signature-256'], config.appSecret)
    ) {
      throw new AppError(401, 'UNAUTHENTICATED', 'Invalid webhook signature.');
    }
    let body: unknown;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new AppError(400, 'VALIDATION_FAILED', 'Invalid webhook body.');
    }
    const inboxEvents: {
      channel: NonNullable<Services['whatsappInbox']>['channels'][number];
      message: unknown;
    }[] = [];
    const inboxReceipts: {
      channel: NonNullable<Services['whatsappInbox']>['channels'][number];
      receipt: ReturnType<typeof statusReceipts>[number];
    }[] = [];
    const inboxStops: (ReturnType<typeof stopRequests>[number] & { senderId: string })[] = [];
    if (services.whatsappInbox) {
      for (const entry of Envelope.parse(body).entry)
        for (const change of entry.changes) {
          if (change.field !== 'messages') continue;
          const value = Value.parse(change.value);
          const channel = services.whatsappInbox.channels.find(
            (c) => c.businessId === entry.id && c.senderId === value.metadata.phone_number_id,
          );
          if (!channel) continue;
          for (const message of value.messages ?? []) inboxEvents.push({ channel, message });
        }
      for (const channel of services.whatsappInbox.channels) {
        for (const receipt of statusReceipts(body, channel.senderId, channel.businessId))
          inboxReceipts.push({ channel, receipt });
        if (channel.senderId !== config.senderId || channel.businessId !== config.businessAccountId)
          inboxStops.push(
            ...stopRequests(body, channel.senderId, channel.businessId).map((r) => ({
              ...r,
              senderId: channel.senderId,
            })),
          );
      }
      if (inboxEvents.length + inboxReceipts.length > 100)
        throw new AppError(400, 'VALIDATION_FAILED', 'Too many inbox events.');
    }
    const receipts = statusReceipts(body, config.senderId, config.businessAccountId);
    const stops = stopRequests(body, config.senderId, config.businessAccountId);
    if (receipts.length + stops.length > 100)
      throw new AppError(400, 'VALIDATION_FAILED', 'Too many events.');
    if (
      receipts.length ||
      stops.length ||
      inboxEvents.length ||
      inboxReceipts.length ||
      inboxStops.length
    ) {
      try {
        // Persist only sanitized, correlated status metadata. Redis may be offline: the
        // worker drains this durable inbox after recovery, including callback-before-send.
        for (const e of inboxEvents) await receiveInbox(services, e.channel, e.message);
        for (const e of inboxReceipts)
          await receiveInboxStatus(
            services,
            e.channel.organisationId,
            e.channel.senderId,
            e.receipt,
          );
        await withMessaging(services.db, async (tx) => {
          for (const receipt of receipts) {
            await tx.$queryRaw`SELECT messaging_receive_status(${randomUUID()}::uuid,
              ${config.senderId}, ${receipt.messageId}, ${receipt.correlationId}::uuid,
              ${receipt.status}, ${receipt.occurredAt}, ${receipt.errorCode}::integer)`;
          }
          for (const stop of inboxStops)
            await tx.$executeRaw`SELECT messaging_opt_out_phone(${stop.eventId},${stop.senderId},${stop.phone},${stop.at})`;
          for (const stop of stops) {
            await tx.$executeRaw`SELECT messaging_opt_out_phone(${stop.eventId}, ${config.senderId}, ${stop.phone}, ${stop.at})`;
          }
        });
      } catch {
        // Meta retries a non-200 response. Never acknowledge a receipt that was not saved.
        throw new AppError(503, 'UNAVAILABLE', 'Receipt storage is unavailable.');
      }
    }
    return reply.send({ received: true });
  });
};
