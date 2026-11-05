import { withAuth, withTenant, type Tx, type Prisma } from '@dhc/db';
import {
  InboxThread,
  InboxMessage,
  InboxTemplate,
  type InboxQuery,
  type InboxReply,
  type Role,
} from '@dhc/contracts';
import type { FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { AppError } from '../../errors';
import type { Services } from '../../services';
import { writeAudit } from '../audit/write';
import { ensureChannel } from './incoming';
export type InboxActor = { userId: string; organisationId: string; role: Role };
type Thread = Prisma.InboxThreadGetPayload<object>;
export const missing = () => new AppError(404, 'NOT_FOUND', 'Not found.');
export const conflict = (message = 'This conversation changed. Refresh before continuing.') =>
  new AppError(409, 'CONFLICT', message);
export const full = (a: InboxActor, t: Thread) =>
  (a.role === 'front_desk' && !t.assignedDoctorId) ||
  (a.role === 'doctor' && t.assignedDoctorId === a.userId);
export const windowOpen = (s: Services, t: Thread) =>
  t.lastInboundAt.getTime() + 24 * 3600000 > s.now().getTime() + 60000;
export function channelFor(s: Services, org: string) {
  const c = s.whatsappInbox?.channels.find((c) => c.organisationId === org);
  if (!c)
    throw new AppError(503, 'UNAVAILABLE', 'WhatsApp inbox is not configured for this clinic.');
  return c;
}
export class InboxService {
  constructor(readonly s: Services) {}
  async staff(tx: Tx, a: InboxActor) {
    if (
      !['doctor', 'front_desk', 'clinic_admin'].includes(a.role) ||
      !(await tx.membership.findFirst({
        where: { userId: a.userId, role: a.role, status: 'active' },
      }))
    )
      throw new AppError(403, 'FORBIDDEN', 'Your clinic role is not active.');
  }
  async thread(tx: Tx, a: InboxActor, id: string, read = false) {
    await this.staff(tx, a);
    const row = await tx.inboxThread.findUnique({ where: { id } });
    if (!row || (a.role === 'doctor' && row.assignedDoctorId !== a.userId)) throw missing();
    if (read && !full(a, row))
      throw new AppError(403, 'FORBIDDEN', 'This conversation is restricted to its assigned team.');
    return row;
  }
  out(a: InboxActor, t: Thread) {
    const canRead = full(a, t);
    return InboxThread.parse({
      ...t,
      phone: canRead ? this.s.cipher.decrypt(t.phoneCipher) : null,
      lastInboundAt: t.lastInboundAt.toISOString(),
      windowEndsAt: new Date(t.lastInboundAt.getTime() + 86400000).toISOString(),
      updatedAt: t.updatedAt.toISOString(),
      canRead,
      canReply: canRead && !t.stoppedAt && t.state === 'open' && windowOpen(this.s, t),
      stopped: !!t.stoppedAt,
      templateConsent: !!t.optedInAt && (!t.stoppedAt || t.optedInAt > t.stoppedAt),
    });
  }
  message(r: Prisma.InboxMessageGetPayload<object>) {
    return InboxMessage.parse({
      ...r,
      body: this.s.cipher.decrypt(r.bodyCipher),
      createdAt: r.createdAt.toISOString(),
      occurredAt: r.occurredAt.toISOString(),
    });
  }
  template(r: Prisma.InboxTemplateGetPayload<object>) {
    return InboxTemplate.parse({
      ...r,
      body: this.s.cipher.decrypt(r.bodyCipher),
      verifiedAt: r.verifiedAt.toISOString(),
    });
  }
  async audit(tx: Tx, req: FastifyRequest, a: InboxActor, id: string, action: string) {
    await writeAudit(tx, req, {
      organisationId: a.organisationId,
      actorUserId: a.userId,
      action: 'inbox.' + action,
      entityType: 'inbox',
      entityId: id,
    });
  }
  async list(a: InboxActor, q: InboxQuery) {
    return withTenant(this.s.db, a.organisationId, async (tx) => {
      await this.staff(tx, a);
      const rows = await tx.inboxThread.findMany({
        where: {
          ...(a.role === 'doctor' ? { assignedDoctorId: a.userId } : {}),
          ...(q.state ? { state: q.state } : {}),
        },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take: q.limit + 1,
        ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      });
      return {
        available: !!this.s.whatsappInbox?.channels.some(
          (c) => c.organisationId === a.organisationId,
        ),
        data: rows.slice(0, q.limit).map((r) => this.out(a, r)),
        nextCursor: rows.length > q.limit ? rows[q.limit - 1]!.id : null,
      };
    });
  }
  async messages(req: FastifyRequest, a: InboxActor, id: string, q: InboxQuery) {
    return withTenant(this.s.db, a.organisationId, async (tx) => {
      const t = await this.thread(tx, a, id, true),
        rows = await tx.inboxMessage.findMany({
          where: { threadId: id },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: q.limit + 1,
          ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
        });
      await this.audit(tx, req, a, id, 'viewed');
      return {
        thread: this.out(a, t),
        data: rows.slice(0, q.limit).map((r) => this.message(r)),
        nextCursor: rows.length > q.limit ? rows[q.limit - 1]!.id : null,
      };
    });
  }
  async action(
    req: FastifyRequest,
    a: InboxActor,
    id: string,
    b: { revision: number; state?: string; markRead?: boolean },
  ) {
    return withTenant(this.s.db, a.organisationId, async (tx) => {
      await tx.$queryRaw`SELECT id FROM inbox_threads WHERE id=${id}::uuid FOR UPDATE`;
      const t = await this.thread(tx, a, id, true);
      if (t.revision !== b.revision) throw conflict();
      const row = await tx.inboxThread.update({
        where: { id },
        data: {
          ...(b.state ? { state: b.state } : {}),
          ...(b.markRead ? { unread: 0 } : {}),
          revision: { increment: 1 },
          updatedAt: this.s.now(),
        },
      });
      await this.audit(
        tx,
        req,
        a,
        id,
        b.markRead ? 'read' : b.state === 'resolved' ? 'resolved' : 'reopened',
      );
      return this.out(a, row);
    });
  }
  async assign(
    req: FastifyRequest,
    a: InboxActor,
    id: string,
    b: { revision: number; doctorId: string | null },
  ) {
    return withTenant(this.s.db, a.organisationId, async (tx) => {
      await tx.$queryRaw`SELECT id FROM inbox_threads WHERE id=${id}::uuid FOR UPDATE`;
      const t = await this.thread(tx, a, id);
      if (t.revision !== b.revision) throw conflict();
      if (t.assignedDoctorId && t.assignedDoctorId !== a.userId)
        throw new AppError(
          403,
          'FORBIDDEN',
          'Only the assigned doctor can release or hand over this conversation.',
        );
      if (
        b.doctorId &&
        !(await tx.membership.findFirst({
          where: { userId: b.doctorId, role: 'doctor', status: 'active' },
        }))
      )
        throw missing();
      const row = await tx.inboxThread.update({
        where: { id },
        data: { assignedDoctorId: b.doctorId, revision: { increment: 1 }, updatedAt: this.s.now() },
      });
      await this.audit(tx, req, a, id, 'assigned');
      return this.out(a, row);
    });
  }
  async consent(
    req: FastifyRequest,
    a: InboxActor,
    id: string,
    b: { revision: number; enabled: boolean; source: string },
  ) {
    return withTenant(this.s.db, a.organisationId, async (tx) => {
      await tx.$queryRaw`SELECT id FROM inbox_threads WHERE id=${id}::uuid FOR UPDATE`;
      const t = await this.thread(tx, a, id, true);
      if (t.revision !== b.revision) throw conflict();
      const now = this.s.now(),
        row = await tx.inboxThread.update({
          where: { id },
          data: {
            optedInAt: b.enabled ? now : null,
            optInSource: b.enabled ? b.source : null,
            stoppedAt: b.enabled ? null : now,
            revision: { increment: 1 },
            updatedAt: now,
          },
        });
      if (!b.enabled)
        await tx.inboxMessage.updateMany({
          where: { threadId: id, state: 'queued' },
          data: { state: 'skipped', statusAt: now },
        });
      await this.audit(tx, req, a, id, b.enabled ? 'consent_recorded' : 'consent_revoked');
      return this.out(a, row);
    });
  }
  async templates(a: InboxActor) {
    return withTenant(this.s.db, a.organisationId, async (tx) => {
      await this.staff(tx, a);
      const rows = await tx.inboxTemplate.findMany({
        where:
          a.role === 'clinic_admin'
            ? {}
            : { enabled: true, supported: true, providerStatus: 'APPROVED' },
        orderBy: [{ name: 'asc' }, { language: 'asc' }],
        take: 1000,
      });
      return {
        available: !!this.s.whatsappInbox?.channels.some(
          (c) => c.organisationId === a.organisationId,
        ),
        data: rows.map((r) => this.template(r)),
      };
    });
  }
  async sync(req: FastifyRequest, a: InboxActor) {
    const c = channelFor(this.s, a.organisationId);
    await withTenant(this.s.db, a.organisationId, (tx) => this.staff(tx, a));
    await ensureChannel(this.s, c);
    let rows;
    try {
      rows = await this.s.whatsappInbox!.gateway.templates(c);
    } catch {
      throw new AppError(
        503,
        'UNAVAILABLE',
        'Template synchronization failed. Existing settings have not changed.',
      );
    }
    await withTenant(this.s.db, a.organisationId, async (tx) => {
      await this.staff(tx, a);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${c.senderId + ':templates'},0))`;
      const seen = new Set<string>();
      for (const r of rows) {
        if (seen.has(r.id)) throw conflict('The provider returned duplicate templates. Try again.');
        seen.add(r.id);
        const body = r.components.find((x) => x.type === 'BODY')?.text ?? '',
          supported =
            r.category === 'UTILITY' &&
            r.components.length === 1 &&
            r.components[0]!.type === 'BODY' &&
            !!body &&
            !body.includes('{{') &&
            body.length <= 1024;
        const hash = this.s.inboxPayloadHash(
            'template',
            JSON.stringify([r.name, r.language, r.category, r.status, body, supported]),
          ),
          prior = await tx.inboxTemplate.findUnique({
            where: { senderId_providerId: { senderId: c.senderId, providerId: r.id } },
          });
        await tx.inboxTemplate.upsert({
          where: { senderId_providerId: { senderId: c.senderId, providerId: r.id } },
          create: {
            id: randomUUID(),
            organisationId: a.organisationId,
            senderId: c.senderId,
            providerId: r.id,
            name: r.name,
            language: r.language,
            category: r.category,
            providerStatus: r.status,
            bodyCipher: this.s.cipher.encrypt(body),
            contentHash: hash,
            supported,
            verifiedAt: this.s.now(),
          },
          update: {
            name: r.name,
            language: r.language,
            category: r.category,
            providerStatus: r.status,
            bodyCipher: this.s.cipher.encrypt(body),
            contentHash: hash,
            supported,
            verifiedAt: this.s.now(),
            ...(prior?.contentHash !== hash ? { enabled: false, revision: { increment: 1 } } : {}),
          },
        });
      }
      await tx.inboxTemplate.updateMany({
        where: { senderId: c.senderId, providerId: { notIn: [...seen] } },
        data: {
          providerStatus: 'MISSING',
          enabled: false,
          verifiedAt: this.s.now(),
          revision: { increment: 1 },
        },
      });
      await this.audit(tx, req, a, randomUUID(), 'templates_synchronized');
    });
    return this.templates(a);
  }
  async toggle(
    req: FastifyRequest,
    a: InboxActor,
    id: string,
    b: { revision: number; enabled: boolean },
  ) {
    return withTenant(this.s.db, a.organisationId, async (tx) => {
      await this.staff(tx, a);
      await tx.$queryRaw`SELECT id FROM inbox_templates WHERE id=${id}::uuid FOR UPDATE`;
      const r = await tx.inboxTemplate.findUnique({ where: { id } });
      if (!r) throw missing();
      if (r.revision !== b.revision) throw conflict();
      if (
        b.enabled &&
        (!r.supported ||
          r.providerStatus !== 'APPROVED' ||
          r.verifiedAt.getTime() < this.s.now().getTime() - 3600000)
      )
        throw conflict('Synchronize an approved, supported utility template first.');
      const row = await tx.inboxTemplate.update({
        where: { id },
        data: { enabled: b.enabled, revision: { increment: 1 } },
      });
      await this.audit(tx, req, a, id, b.enabled ? 'template_enabled' : 'template_disabled');
      return this.template(row);
    });
  }
  async enqueue(req: FastifyRequest, a: InboxActor, id: string, b: InboxReply) {
    const channel = channelFor(this.s, a.organisationId);
    const hash = this.s.inboxPayloadHash(
      'reply',
      JSON.stringify({ threadId: id, text: b.text ?? null, templateId: b.templateId ?? null }),
    );
    return withTenant(this.s.db, a.organisationId, async (tx) => {
      await tx.$queryRaw`SELECT id FROM inbox_threads WHERE id=${id}::uuid FOR UPDATE`;
      const t = await this.thread(tx, a, id, true),
        prior = await tx.inboxMessage.findUnique({ where: { id: b.id } });
      if (prior) {
        if (prior.threadId !== id || prior.sentByUserId !== a.userId || prior.inputHash !== hash)
          throw conflict('This send reference was already used.');
        return this.message(prior);
      }
      if (t.senderId !== channel.senderId)
        throw conflict('This inbox number is no longer configured.');
      if (t.stoppedAt || t.state !== 'open')
        throw conflict('This conversation is stopped or resolved.');
      if (b.text && !windowOpen(this.s, t))
        throw conflict(
          'The reply window is closed. Choose an approved template with recorded consent.',
        );
      const template = b.templateId
        ? await tx.inboxTemplate.findUnique({ where: { id: b.templateId } })
        : null;
      if (
        b.templateId &&
        (!template ||
          template.senderId !== t.senderId ||
          !template.enabled ||
          !template.supported ||
          template.providerStatus !== 'APPROVED' ||
          template.verifiedAt.getTime() < this.s.now().getTime() - 3600000 ||
          !t.optedInAt)
      )
        throw conflict('Use a current approved utility template and record explicit consent.');
      if (
        (await tx.inboxMessage.count({
          where: {
            threadId: id,
            direction: 'outbound',
            createdAt: { gt: new Date(this.s.now().getTime() - 3600000) },
          },
        })) >= 20
      )
        throw new AppError(429, 'RATE_LIMITED', 'Too many replies to this number. Try later.');
      const now = this.s.now(),
        row = await tx.inboxMessage.create({
          data: {
            id: b.id,
            organisationId: a.organisationId,
            threadId: id,
            senderId: t.senderId,
            direction: 'outbound',
            kind: template ? 'template' : 'text',
            bodyCipher: this.s.cipher.encrypt(
              template ? this.s.cipher.decrypt(template.bodyCipher) : b.text!,
            ),
            inputHash: hash,
            state: 'queued',
            occurredAt: now,
            createdAt: now,
            statusAt: now,
            sentByUserId: a.userId,
            sentByRole: a.role,
            templateId: template?.id,
            templateRevision: template?.revision,
          },
        });
      await this.audit(tx, req, a, b.id, 'reply_queued');
      return this.message(row);
    });
  }
  async doctors(a: InboxActor) {
    const ids = await withTenant(this.s.db, a.organisationId, async (tx) => {
      await this.staff(tx, a);
      return (
        await tx.membership.findMany({
          where: { role: 'doctor', status: 'active' },
          select: { userId: true },
        })
      ).map((r) => r.userId);
    });
    return {
      data: await withAuth(this.s.db, (tx) =>
        tx.user
          .findMany({
            where: { id: { in: ids }, status: 'active' },
            select: { id: true, displayName: true, email: true },
          })
          .then((rows) => rows.map((r) => ({ id: r.id, name: r.displayName ?? r.email ?? r.id }))),
      ),
    };
  }
}
