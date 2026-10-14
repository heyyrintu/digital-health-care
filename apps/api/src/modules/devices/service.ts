import type { PushDevice, RegisterPushDeviceBody } from '@dhc/contracts';
import { withAuth, type Prisma } from '@dhc/db';
import type { FastifyRequest } from 'fastify';
import type { AccessClaims } from '../../auth/tokens';
import { AppError } from '../../errors';
import type { Services } from '../../services';
import { writeAudit } from '../audit/write';

const NOT_FOUND = () => new AppError(404, 'NOT_FOUND', 'Not found.');

type Row = Prisma.PushDeviceGetPayload<object>;

/**
 * Push devices (Clinic and Patient apps): a device registers its Expo token under the
 * signed-in session and stops receiving when that session ends or the person removes it.
 * A token is one physical install, so registering it again (another person signs in on a
 * shared iPad) moves it to the new session instead of sending to both.
 */
export class PushDeviceService {
  constructor(private readonly s: Services) {}

  async register(
    request: FastifyRequest,
    actor: AccessClaims,
    body: RegisterPushDeviceBody,
  ): Promise<PushDevice> {
    const now = this.s.now();
    const data = {
      userId: actor.userId,
      organisationId: actor.organisationId,
      sessionId: actor.sessionId,
      platform: body.platform,
      appVariant: body.appVariant,
      deviceName: body.deviceName ?? null,
      lastSeenAt: now,
      revokedAt: null,
      revokedReason: null,
    };
    return withAuth(this.s.db, async (tx) => {
      // Serialise registrations of one token so two sign-ins cannot both insert it.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`push-token:${body.expoPushToken}`}))`;
      const existing = await tx.pushDevice.findUnique({
        where: { expoPushToken: body.expoPushToken },
      });
      const row = existing
        ? await tx.pushDevice.update({ where: { id: existing.id }, data })
        : await tx.pushDevice.create({ data: { ...data, expoPushToken: body.expoPushToken } });
      const moved = !!existing && (existing.sessionId !== actor.sessionId || !!existing.revokedAt);
      if (!existing || moved) {
        await writeAudit(tx, request, {
          action: 'push_device.registered',
          organisationId: actor.organisationId,
          actorUserId: actor.userId,
          entityType: 'push_device',
          entityId: row.id,
          metadata: { platform: body.platform, appVariant: body.appVariant, moved },
        });
      }
      return this.out(row, actor);
    });
  }

  async list(actor: AccessClaims): Promise<PushDevice[]> {
    const rows = await withAuth(this.s.db, (tx) =>
      tx.pushDevice.findMany({
        where: {
          userId: actor.userId,
          organisationId: actor.organisationId,
          revokedAt: null,
          session: { revokedAt: null, expiresAt: { gt: this.s.now() } },
        },
        orderBy: { lastSeenAt: 'desc' },
      }),
    );
    return rows.map((r) => this.out(r, actor));
  }

  async remove(request: FastifyRequest, actor: AccessClaims, id: string): Promise<void> {
    await withAuth(this.s.db, async (tx) => {
      const { count } = await tx.pushDevice.updateMany({
        where: {
          id,
          userId: actor.userId,
          organisationId: actor.organisationId,
          revokedAt: null,
        },
        data: { revokedAt: this.s.now(), revokedReason: 'removed' },
      });
      if (count === 0) throw NOT_FOUND();
      await writeAudit(tx, request, {
        action: 'push_device.removed',
        organisationId: actor.organisationId,
        actorUserId: actor.userId,
        entityType: 'push_device',
        entityId: id,
      });
    });
  }

  private out(r: Row, actor: AccessClaims): PushDevice {
    return {
      id: r.id,
      platform: r.platform,
      appVariant: r.appVariant,
      deviceName: r.deviceName,
      current: r.sessionId === actor.sessionId,
      createdAt: r.createdAt.toISOString(),
      lastSeenAt: r.lastSeenAt.toISOString(),
    };
  }
}
