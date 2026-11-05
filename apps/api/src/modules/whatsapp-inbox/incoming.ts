import { z } from 'zod';
import { withTenant } from '@dhc/db';
import { randomUUID } from 'node:crypto';
import type { Services } from '../../services';
import type { InboxChannelConfig } from './gateway';
export const Incoming = z.object({
  id: z.string().min(1).max(512),
  from: z.string().regex(/^91[6-9]\d{9}$/),
  timestamp: z.string().regex(/^\d{1,12}$/),
  type: z.string().max(40),
  text: z.object({ body: z.string().max(8192) }).optional(),
});
export async function ensureChannel(s: Services, c: InboxChannelConfig) {
  return withTenant(s.db, c.organisationId, async (tx) => {
    const prior = await tx.inboxChannel.findUnique({ where: { senderId: c.senderId } });
    if (prior) {
      if (prior.businessId !== c.businessId) throw new Error('Inbox binding mismatch');
      return;
    }
    await tx.inboxChannel.createMany({
      data: {
        senderId: c.senderId,
        organisationId: c.organisationId,
        businessId: c.businessId,
        createdAt: s.now(),
      },
      skipDuplicates: true,
    });
    const row = await tx.inboxChannel.findUnique({ where: { senderId: c.senderId } });
    if (!row || row.businessId !== c.businessId) throw new Error('Inbox sender already bound');
  });
}
export async function receiveInbox(s: Services, c: InboxChannelConfig, raw: unknown) {
  const parsed = Incoming.safeParse(raw);
  if (!parsed.success) return;
  const m = parsed.data,
    at = new Date(Number(m.timestamp) * 1000),
    now = s.now();
  if (
    !Number.isFinite(at.getTime()) ||
    at.getUTCFullYear() > 9999 ||
    at.getTime() > now.getTime() + 300000
  )
    return;
  await ensureChannel(s, c);
  const phone = '+' + m.from,
    contactKey = s.inboxContactKey(c.senderId, phone),
    body = m.type === 'text' && m.text ? m.text.body : '';
  await withTenant(s.db, c.organisationId, async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${c.senderId + ':' + contactKey},0))`;
    if (
      await tx.inboxMessage.findUnique({
        where: { senderId_providerId: { senderId: c.senderId, providerId: m.id } },
      })
    )
      return;
    const prior = await tx.inboxThread.findUnique({
      where: { senderId_contactKey: { senderId: c.senderId, contactKey } },
    });
    const thread =
      prior ??
      (await tx.inboxThread.create({
        data: {
          id: randomUUID(),
          organisationId: c.organisationId,
          senderId: c.senderId,
          contactKey,
          phoneCipher: s.cipher.encrypt(phone),
          last4: phone.slice(-4),
          lastInboundAt: new Date(Math.min(at.getTime(), now.getTime())),
          updatedAt: now,
        },
      }));
    await tx.$queryRaw`SELECT id FROM inbox_threads WHERE id=${thread.id}::uuid FOR UPDATE`;
    const current = await tx.inboxThread.findUniqueOrThrow({ where: { id: thread.id } });
    const stop = body.trim().toUpperCase() === 'STOP',
      newStop =
        stop &&
        (!current.stoppedAt || at > current.stoppedAt) &&
        (!current.optedInAt || at >= current.optedInAt);
    await tx.inboxThread.update({
      where: { id: thread.id },
      data: {
        lastInboundAt: new Date(
          Math.max(current.lastInboundAt.getTime(), Math.min(at.getTime(), now.getTime())),
        ),
        updatedAt: now,
        unread: { increment: 1 },
        revision: { increment: 1 },
        state: 'open',
        ...(newStop ? { stoppedAt: at, optedInAt: null, optInSource: null } : {}),
      },
    });
    await tx.inboxMessage.create({
      data: {
        id: randomUUID(),
        organisationId: c.organisationId,
        threadId: thread.id,
        senderId: c.senderId,
        providerId: m.id,
        direction: 'inbound',
        kind: m.type === 'text' && m.text ? 'text' : 'unsupported',
        bodyCipher: s.cipher.encrypt(body),
        state: 'received',
        occurredAt: at,
        createdAt: now,
        statusAt: now,
      },
    });
    if (newStop)
      await tx.inboxMessage.updateMany({
        where: { threadId: thread.id, state: 'queued' },
        data: { state: 'skipped', statusAt: now },
      });
  });
}
