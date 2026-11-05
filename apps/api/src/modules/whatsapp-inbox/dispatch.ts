import { withAuth, withTenant } from '@dhc/db';
import type { Services } from '../../services';
import { channelFor, full, windowOpen, type InboxActor } from './service';
const active = new Set<string>();
/** Commit one authorization before the network call. Unknown outcomes are never replayed. */
export async function dispatchInbox(s: Services, org: string, id: string) {
  if (active.has(id) || active.size >= 4) return;
  active.add(id);
  try {
    const c = channelFor(s, org),
      orgRow = await withAuth(s.db, (tx) =>
        tx.organisation.findUnique({ where: { id: org }, select: { status: true } }),
      );
    const claim = await withTenant(s.db, org, async (tx) => {
      const found = await tx.inboxMessage.findUnique({ where: { id } });
      if (!found) return null;
      await tx.$queryRaw`SELECT id FROM inbox_threads WHERE id=${found.threadId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM inbox_messages WHERE id=${id}::uuid FOR UPDATE`;
      const m = await tx.inboxMessage.findUniqueOrThrow({ where: { id } }),
        t = await tx.inboxThread.findUniqueOrThrow({ where: { id: m.threadId } });
      if (m.state !== 'queued') return null;
      const a = { userId: m.sentByUserId!, organisationId: org, role: m.sentByRole } as InboxActor;
      const senderUser = await withAuth(s.db, (auth) =>
        auth.user.findUnique({ where: { id: a.userId }, select: { status: true } }),
      );
      let allowed =
        senderUser?.status === 'active' &&
        orgRow?.status === 'active' &&
        t.senderId === c.senderId &&
        t.state === 'open' &&
        !t.stoppedAt &&
        full(a, t);
      if (
        !(await tx.membership.findFirst({
          where: { userId: a.userId, role: a.role, status: 'active' },
        }))
      )
        allowed = false;
      if (m.templateId)
        await tx.$queryRaw`SELECT id FROM inbox_templates WHERE id=${m.templateId}::uuid FOR SHARE`;
      const template = m.templateId
        ? await tx.inboxTemplate.findUnique({ where: { id: m.templateId } })
        : null;
      if (m.kind === 'text' && !windowOpen(s, t)) allowed = false;
      if (
        m.kind === 'template' &&
        (!template ||
          template.senderId !== c.senderId ||
          !template.enabled ||
          !template.supported ||
          template.providerStatus !== 'APPROVED' ||
          template.revision !== m.templateRevision ||
          template.verifiedAt.getTime() < s.now().getTime() - 3600000 ||
          !t.optedInAt)
      )
        allowed = false;
      await tx.inboxMessage.update({
        where: { id },
        data: {
          state: allowed ? 'sending' : 'skipped',
          attemptAt: allowed ? s.now() : null,
          statusAt: s.now(),
        },
      });
      if (!allowed) return null;
      return {
        to: s.cipher.decrypt(t.phoneCipher),
        id,
        ...(template
          ? { template: { name: template.name, language: template.language } }
          : { text: s.cipher.decrypt(m.bodyCipher) }),
      };
    });
    if (!claim) return;
    let result;
    try {
      result = await s.whatsappInbox!.gateway.send(c, claim);
    } catch {
      result = { state: 'uncertain' as const };
    }
    await withTenant(s.db, org, async (tx) => {
      await tx.$queryRaw`SELECT id FROM inbox_messages WHERE id=${id}::uuid FOR UPDATE`;
      const m = await tx.inboxMessage.findUniqueOrThrow({ where: { id } });
      // A signed status may have bound the message before the HTTP response arrived.
      if (m.providerId && result.messageId && m.providerId !== result.messageId) {
        if (m.state === 'sending')
          await tx.inboxMessage.update({
            where: { id },
            data: { state: 'uncertain', statusAt: s.now() },
          });
        return;
      }
      if (m.state === 'sending')
        await tx.inboxMessage.update({
          where: { id },
          data: {
            state: result.state,
            providerId: result.messageId ?? m.providerId,
            errorCode: result.errorCode ?? null,
            statusAt: s.now(),
          },
        });
      await tx.auditLog.create({
        data: {
          organisationId: org,
          actorUserId: m.sentByUserId,
          action: 'inbox.reply_authorized',
          entityType: 'inbox_message',
          entityId: id,
        },
      });
    });
  } finally {
    active.delete(id);
  }
}
export async function receiveInboxStatus(
  s: Services,
  org: string,
  sender: string,
  r: {
    messageId: string;
    correlationId: string | null;
    status: string;
    occurredAt: Date;
    errorCode: number | null;
  },
) {
  if (r.occurredAt.getTime() > s.now().getTime() + 300000) return;
  await withTenant(s.db, org, async (tx) => {
    const m = await tx.inboxMessage.findFirst({
      where: {
        senderId: sender,
        direction: 'outbound',
        OR: [{ providerId: r.messageId }, ...(r.correlationId ? [{ id: r.correlationId }] : [])],
      },
    });
    if (!m) return;
    await tx.$queryRaw`SELECT id FROM inbox_messages WHERE id=${m.id}::uuid FOR UPDATE`;
    const row = await tx.inboxMessage.findUniqueOrThrow({ where: { id: m.id } });
    if (
      row.state === 'queued' ||
      row.state === 'skipped' ||
      (row.providerId && row.providerId !== r.messageId) ||
      (r.correlationId && r.correlationId !== row.id)
    )
      return;
    const rank: Record<string, number> = {
      sending: 0,
      uncertain: 0,
      accepted: 1,
      sent: 2,
      failed: 2,
      delivered: 3,
      read: 4,
    };
    if (
      (rank[r.status] ?? -1) < (rank[row.state] ?? -1) ||
      (rank[r.status] === rank[row.state] && r.occurredAt.getTime() + 999 < row.statusAt.getTime())
    )
      return;
    await tx.inboxMessage.update({
      where: { id: row.id },
      data: {
        state: r.status,
        providerId: r.messageId,
        statusAt: r.occurredAt > row.statusAt ? r.occurredAt : row.statusAt,
        errorCode: r.status === 'failed' ? r.errorCode : null,
      },
    });
  });
}
export function scheduleInbox(s: Services) {
  let running: Promise<void> | null = null,
    stopped = false;
  const tick = () => {
    if (stopped || running || !s.whatsappInbox) return;
    running = (async () => {
      for (const c of s.whatsappInbox!.channels) {
        if (stopped) return;
        try {
          const ids = await withTenant(s.db, c.organisationId, async (tx) => {
            // A process may have died after authorizing a send. Never make a second network call.
            await tx.inboxMessage.updateMany({
              where: { state: 'sending', attemptAt: { lt: new Date(s.now().getTime() - 60000) } },
              data: { state: 'uncertain', statusAt: s.now() },
            });
            return tx.inboxMessage.findMany({
              where: { state: 'queued', senderId: c.senderId },
              orderBy: { createdAt: 'asc' },
              take: 20,
              select: { id: true },
            });
          });
          for (const m of ids) {
            if (stopped) return;
            await dispatchInbox(s, c.organisationId, m.id);
          }
        } catch {
          /* Durable rows remain recoverable; never log provider bodies or tokens. */
        }
      }
    })().finally(() => (running = null));
  };
  const timer = setInterval(tick, 15000);
  timer.unref();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await running;
  };
}
