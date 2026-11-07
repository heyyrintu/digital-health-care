import { randomUUID } from 'node:crypto';
import {
  ReviewSettings,
  type ReviewSettingsBody,
  ReviewRequest as ReviewRequestSchema,
  type RequestReview,
  type ReviewRequest,
  isGoogleReviewUrl,
} from '@dhc/contracts';
import { verifyReviewLinkToken } from '@dhc/secure-links';
import { withTenant, withMessaging, type Tx } from '@dhc/db';
import type { FastifyRequest } from 'fastify';
import type { Services } from '../../services';
import { AppError } from '../../errors';
import { accountPhone } from '../portal/account';
import { writeAudit } from '../audit/write';
type Actor = { userId: string; organisationId: string };
const unavailable = () =>
  new AppError(404, 'NOT_FOUND', 'This review invitation is unavailable or expired.');
export class ReviewsService {
  constructor(readonly s: Services) {}
  async settings(a: Actor) {
    return withTenant(this.s.db, a.organisationId, async (tx) => this.settingsIn(tx, a));
  }
  private async settingsIn(tx: Tx, a: Actor) {
    const r = await tx.reviewSettings.findUnique({ where: { organisationId: a.organisationId } });
    return ReviewSettings.parse({
      version: r?.version ?? 0,
      enabled: r?.enabled ?? false,
      googleUrl: r?.googleUrl ?? null,
      cooldownDays: r?.cooldownDays ?? 90,
      deliveryAvailable: !!(this.s.reviewMessagingSender && this.s.reviewLinkSecret),
    });
  }
  async saveSettings(req: FastifyRequest, a: Actor, b: ReviewSettingsBody) {
    return withTenant(this.s.db, a.organisationId, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${a.organisationId},83))`;
      const old = await tx.reviewSettings.findUnique({
        where: { organisationId: a.organisationId },
      });
      if ((old?.version ?? 0) !== b.version)
        throw new AppError(409, 'CONFLICT', 'Reload the latest review settings.');
      await tx.reviewSettings.upsert({
        where: { organisationId: a.organisationId },
        create: {
          organisationId: a.organisationId,
          version: 1,
          enabled: b.enabled,
          googleUrl: b.googleUrl,
          cooldownDays: b.cooldownDays,
        },
        update: {
          version: { increment: 1 },
          enabled: b.enabled,
          googleUrl: b.googleUrl,
          cooldownDays: b.cooldownDays,
        },
      });
      await writeAudit(tx, req, {
        organisationId: a.organisationId,
        actorUserId: a.userId,
        action: 'review.settings_updated',
        entityType: 'organisation',
        entityId: a.organisationId,
      });
      return this.settingsIn(tx, a);
    });
  }
  async consent(
    req: FastifyRequest,
    a: Actor,
    body?: { enabled: boolean; recipientAgreed: boolean },
  ) {
    const phone = await accountPhone(this.s, a.userId);
    return withTenant(this.s.db, a.organisationId, async (tx) => {
      const settings = await this.settingsIn(tx, a),
        sender = this.s.reviewMessagingSender;
      if (body) {
        if (
          body.enabled &&
          (!settings.enabled || !sender || !settings.googleUrl || !body.recipientAgreed)
        )
          throw new AppError(
            409,
            'BUSINESS_RULE',
            'Optional review invitations are not available yet.',
          );
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${a.organisationId + ':' + phone},0))`;
        if (body.enabled) {
          const old = await tx.whatsAppOptIn.findUnique({
            where: {
              organisationId_phone_senderPhoneNumberId_category: {
                organisationId: a.organisationId,
                phone,
                senderPhoneNumberId: sender!,
                category: 'reviews',
              },
            },
          });
          if (!old?.enabled || old.changedByUserId !== a.userId)
            await tx.whatsAppOptIn.upsert({
              where: {
                organisationId_phone_senderPhoneNumberId_category: {
                  organisationId: a.organisationId,
                  phone,
                  senderPhoneNumberId: sender!,
                  category: 'reviews',
                },
              },
              create: {
                id: randomUUID(),
                organisationId: a.organisationId,
                phone,
                senderPhoneNumberId: sender!,
                category: 'reviews',
                enabled: true,
                changedAt: this.s.now(),
                changedByUserId: a.userId,
              },
              update: {
                enabled: true,
                version: { increment: 1 },
                changedAt: this.s.now(),
                changedByUserId: a.userId,
              },
            });
        } else
          for (const r of await tx.whatsAppOptIn.findMany({
            where: { phone, category: 'reviews', enabled: true },
          }))
            await tx.whatsAppOptIn.update({
              where: { id: r.id },
              data: {
                enabled: false,
                version: { increment: 1 },
                changedAt: this.s.now(),
                changedByUserId: a.userId,
              },
            });
        await writeAudit(tx, req, {
          organisationId: a.organisationId,
          actorUserId: a.userId,
          action: 'review.consent_changed',
          entityType: 'user',
          entityId: a.userId,
          metadata: { enabled: body.enabled },
        });
      }
      const pref = await tx.whatsAppOptIn.findFirst({
        where: {
          phone,
          category: 'reviews',
          ...(sender ? { senderPhoneNumberId: sender } : { enabled: true }),
        },
        orderBy: { changedAt: 'desc' },
      });
      return {
        available: !!(settings.enabled && settings.googleUrl && sender && this.s.reviewLinkSecret),
        enabled: !!pref?.enabled && pref.changedByUserId === a.userId,
        phoneLast4: phone.slice(-4),
      };
    });
  }
  private async view(
    tx: Tx,
    r: {
      id: string;
      appointmentId: string;
      patientId: string;
      createdAt: Date;
      expiresAt: Date;
      cancelledAt: Date | null;
      openedAt: Date | null;
    },
  ): Promise<ReviewRequest> {
    const [p, d] = await Promise.all([
      tx.patient.findUnique({ where: { id: r.patientId }, select: { name: true } }),
      tx.whatsAppDelivery.findUnique({ where: { id: r.id }, select: { status: true } }),
    ]);
    return ReviewRequestSchema.parse({
      ...r,
      patientName: p?.name ?? '',
      createdAt: r.createdAt.toISOString(),
      expiresAt: r.expiresAt.toISOString(),
      openedAt: r.openedAt?.toISOString() ?? null,
      cancelled: !!r.cancelledAt,
      status: d?.status ?? 'unavailable',
    });
  }
  async list(a: Actor, cursor?: string) {
    return withTenant(this.s.db, a.organisationId, async (tx) => {
      if (cursor && !(await tx.reviewRequest.findUnique({ where: { id: cursor } })))
        throw unavailable();
      const rows = await tx.reviewRequest.findMany({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 51,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      const groups = await tx.whatsAppDelivery.groupBy({
        by: ['status'],
        where: { reviewRequestId: { not: null } },
        _count: true,
      });
      const count = (states: string[]) =>
        groups.filter((g) => states.includes(g.status)).reduce((n, g) => n + g._count, 0);
      const data = [];
      for (const r of rows.slice(0, 50)) data.push(await this.view(tx, r));
      return {
        data,
        nextCursor: rows.length > 50 ? rows[49]!.id : null,
        metrics: {
          total: await tx.reviewRequest.count(),
          accepted: count(['accepted', 'sent', 'delivered', 'read']),
          sent: count(['sent', 'delivered', 'read']),
          delivered: count(['delivered', 'read']),
          opened: await tx.reviewRequest.count({ where: { openedAt: { not: null } } }),
        },
      };
    });
  }
  async request(req: FastifyRequest, a: Actor, b: RequestReview) {
    return withTenant(this.s.db, a.organisationId, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${b.id},84))`;
      const prior = await tx.reviewRequest.findUnique({ where: { id: b.id } });
      if (prior) {
        if (prior.appointmentId !== b.appointmentId || prior.createdByUserId !== a.userId)
          throw new AppError(409, 'CONFLICT', 'This request ID was already used.');
        return this.view(tx, prior);
      }
      if (!this.s.reviewMessagingSender || !this.s.reviewLinkSecret)
        throw new AppError(503, 'UNAVAILABLE', 'Review request delivery is not configured.');
      if (!(await tx.appointment.findUnique({ where: { id: b.appointmentId } })))
        throw new AppError(404, 'NOT_FOUND', 'Not found.');
      try {
        await tx.$executeRaw`SELECT enqueue_review_request(${b.id}::uuid,${b.appointmentId}::uuid,${a.userId}::uuid,${this.s.reviewMessagingSender})`;
      } catch {
        throw new AppError(
          409,
          'BUSINESS_RULE',
          'Review request not eligible. Check the completed visit, patient consent, existing request and number cooldown.',
        );
      }
      await writeAudit(tx, req, {
        organisationId: a.organisationId,
        actorUserId: a.userId,
        action: 'review.requested',
        entityType: 'review_request',
        entityId: b.id,
      });
      return this.view(tx, await tx.reviewRequest.findUniqueOrThrow({ where: { id: b.id } }));
    });
  }
  async cancel(req: FastifyRequest, a: Actor, id: string) {
    return withTenant(this.s.db, a.organisationId, async (tx) => {
      if (!(await tx.reviewRequest.findUnique({ where: { id } }))) throw unavailable();
      await tx.$executeRaw`SELECT cancel_review_request(${id}::uuid)`;
      await writeAudit(tx, req, {
        organisationId: a.organisationId,
        actorUserId: a.userId,
        action: 'review.cancelled',
        entityType: 'review_request',
        entityId: id,
      });
      return this.view(tx, await tx.reviewRequest.findUniqueOrThrow({ where: { id } }));
    });
  }
  async resolve(token: string, open = false) {
    const secret = this.s.reviewLinkSecret,
      sender = this.s.reviewMessagingSender;
    const verified = secret ? verifyReviewLinkToken(token, secret, this.s.now()) : null;
    if (!verified || !sender) throw unavailable();
    const [row] = await withMessaging(
      this.s.db,
      (tx) =>
        tx.$queryRaw<
          { clinic_name: string; destination_url: string }[]
        >`SELECT * FROM review_resolve_link(${verified.deliveryId}::uuid,${sender},${open})`,
    );
    if (!row || !isGoogleReviewUrl(row.destination_url)) throw unavailable();
    return open ? { url: row.destination_url } : { clinicName: row.clinic_name };
  }
}
