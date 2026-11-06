import { PeopleService, exclusiveIdentity, tenantRole } from './people';
import {
  STAFF_ROLES,
  type CreatedStaffInvite,
  type ResetAuthenticatorBody,
  type StaffMember,
  type StaffRole,
  type StaffSession,
} from '@dhc/contracts';
import { withAuth, withTenant } from '@dhc/db';
import type { FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';
import { hashToken } from '../../auth/tokens';
import { AppError } from '../../errors';
import type { Services } from '../../services';
import { writeAudit } from '../audit/write';
import { INVITE_TTL_MS, toStaffInvite } from '../invites/service';
import { liveSessionIds, revokePushDevicesForSessions } from '../devices/revoke';

interface Actor {
  userId: string;
  organisationId: string;
  sessionId?: string;
}

const STAFF = [...STAFF_ROLES];

/** Clinic admin views of staff: who is on the team, and resetting someone's sign-in. */
export class StaffService {
  constructor(private readonly s: Services) {}

  /** A person's name is shared across their clinic memberships; only they can change it. */
  async renameSelf(request: FastifyRequest, actor: Actor, displayName: string): Promise<void> {
    await withAuth(this.s.db, async (tx) => {
      await tx.user.update({ where: { id: actor.userId }, data: { displayName } });
      await writeAudit(tx, request, {
        action: 'staff.profile_updated',
        organisationId: actor.organisationId,
        actorUserId: actor.userId,
        entityType: 'user',
        entityId: actor.userId,
      });
    });
  }

  async list(actor: Actor): Promise<StaffMember[]> {
    const memberships = await withTenant(this.s.db, actor.organisationId, (tx) =>
      tx.membership.findMany({
        where: { role: { in: STAFF }, status: { in: ['active', 'invited'] } },
        select: { userId: true, role: true, status: true },
      }),
    );
    const users = await withAuth(this.s.db, (tx) =>
      tx.user.findMany({
        where: { id: { in: [...new Set(memberships.map((m) => m.userId))] } },
        select: {
          id: true,
          email: true,
          phone: true,
          displayName: true,
          lastLoginAt: true,
          passwordHash: true,
          mfaSecret: true,
        },
      }),
    );

    return users
      .map((user): StaffMember => {
        const own = memberships.filter((m) => m.userId === user.id);
        const active = own.filter((m) => m.status === 'active');
        const shown = active.length > 0 ? active : own;
        return {
          userId: user.id,
          displayName: user.displayName,
          identifier: user.email ?? user.phone ?? '',
          roles: shown.map((m) => m.role as StaffRole),
          status: active.length > 0 ? 'active' : 'invited',
          signInReady: Boolean(user.passwordHash && user.mfaSecret),
          lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
        };
      })
      .sort((a, b) => (a.displayName ?? a.identifier).localeCompare(b.displayName ?? b.identifier));
  }

  // ---- Devices (signed-in sessions) -------------------------------------------------

  /**
   * A staff member's live sessions at this clinic, most recently used first. Sessions
   * belong to one clinic, so devices signed in to another clinic never show.
   */
  async sessions(actor: Actor, targetUserId: string): Promise<StaffSession[]> {
    await this.requireStaff(actor, targetUserId);
    const now = this.s.now();
    const rows = await withAuth(this.s.db, (tx) =>
      tx.session.findMany({
        where: {
          userId: targetUserId,
          organisationId: actor.organisationId,
          role: { not: 'patient' },
          revokedAt: null,
          expiresAt: { gt: now },
        },
        orderBy: { lastUsedAt: 'desc' },
      }),
    );
    return rows.map((r) => ({
      id: r.id,
      userAgent: r.userAgent,
      ip: r.ip,
      signedInAt: r.createdAt.toISOString(),
      lastUsedAt: r.lastUsedAt.toISOString(),
      current: r.id === actor.sessionId,
    }));
  }

  /** Signs one device out; its next request gets 401. */
  async revokeSession(request: FastifyRequest, actor: Actor, sessionId: string): Promise<void> {
    await withAuth(this.s.db, async (tx) => {
      const session = await tx.session.findFirst({
        where: {
          id: sessionId,
          organisationId: actor.organisationId,
          role: { not: 'patient' },
          revokedAt: null,
        },
        select: { userId: true },
      });
      if (!session) throw new AppError(404, 'NOT_FOUND', 'Not found.');
      const now = this.s.now();
      await tx.session.update({
        where: { id: sessionId },
        data: { revokedAt: now, revokedReason: 'admin_signout' },
      });
      // The device stops getting push notifications in the same transaction.
      await revokePushDevicesForSessions(tx, [sessionId], 'admin_signout', now);
      await writeAudit(tx, request, {
        action: 'staff.session.revoked',
        organisationId: actor.organisationId,
        actorUserId: actor.userId,
        entityType: 'session',
        entityId: sessionId,
        metadata: { targetUserId: session.userId },
      });
    });
  }

  /** Signs a staff member out of every device at this clinic. Their access stays. */
  async signOutAll(
    request: FastifyRequest,
    actor: Actor,
    targetUserId: string,
  ): Promise<{ revoked: number }> {
    await this.requireStaff(actor, targetUserId);
    return withAuth(this.s.db, async (tx) => {
      const now = this.s.now();
      // Only this clinic's staff sessions: their sessions elsewhere stay signed in.
      const ending = (
        await tx.session.findMany({
          where: {
            userId: targetUserId,
            organisationId: actor.organisationId,
            role: { not: 'patient' },
            revokedAt: null,
          },
          select: { id: true },
        })
      ).map((r) => r.id);
      const { count } = await tx.session.updateMany({
        where: { id: { in: ending }, revokedAt: null },
        data: { revokedAt: now, revokedReason: 'admin_signout' },
      });
      await revokePushDevicesForSessions(tx, ending, 'admin_signout', now);
      await writeAudit(tx, request, {
        action: 'staff.sessions.revoked_all',
        organisationId: actor.organisationId,
        actorUserId: actor.userId,
        entityType: 'user',
        entityId: targetUserId,
        metadata: { sessionsRevoked: count },
      });
      return { revoked: count };
    });
  }

  /** Another organisation's staff (or a patient) read as not found. */
  private async requireStaff(actor: Actor, targetUserId: string): Promise<void> {
    const count = await withTenant(this.s.db, actor.organisationId, (tx) =>
      tx.membership.count({ where: { userId: targetUserId, role: { in: STAFF } } }),
    );
    if (count === 0) throw new AppError(404, 'NOT_FOUND', 'Not found.');
  }

  /**
   * Clears a staff member's password and authenticator, signs them out of every staff
   * session, and returns a single-use setup link for them to choose new ones.
   */
  async resetAuthenticator(
    request: FastifyRequest,
    actor: Actor,
    targetUserId: string,
    body: ResetAuthenticatorBody,
  ): Promise<CreatedStaffInvite> {
    if (targetUserId === actor.userId) {
      throw new AppError(
        409,
        'CONFLICT',
        'You can’t reset your own sign-in. Ask another clinic admin.',
      );
    }
    if (!actor.sessionId) throw new AppError(401, 'UNAUTHENTICATED', 'Please sign in again.');
    const now = this.s.now();
    const token = randomBytes(32).toString('base64url');
    return new PeopleService(this.s).admin(
      { ...actor, sessionId: actor.sessionId },
      targetUserId,
      async (tx) => {
        const roles = (
          await tx.membership.findMany({
            where: {
              organisationId: actor.organisationId,
              userId: targetUserId,
              role: { in: STAFF },
              status: 'active',
            },
            select: { role: true },
          })
        ).map((m) => m.role as StaffRole);
        if (!roles.length) throw new AppError(404, 'NOT_FOUND', 'Not found.');
        const role = body.role ?? roles[0]!;
        if (!roles.includes(role))
          throw new AppError(
            400,
            'VALIDATION_FAILED',
            'This person does not have that role here.',
            { role: roles.join(',') },
          );
        if (!(await exclusiveIdentity(tx, targetUserId, actor.organisationId)))
          throw new AppError(
            409,
            'CONFLICT',
            'This person has a shared sign-in, so only platform support can reset it.',
          );
        const user = await tx.user.update({
          where: { id: targetUserId },
          data: {
            passwordHash: null,
            mfaSecret: null,
            mfaPendingSecret: null,
            mfaLastUsedStep: null,
            failedLoginCount: 0,
            lockedUntil: null,
          },
        });
        const ending = await liveSessionIds(tx, { userId: targetUserId, staffOnly: true });
        const revoked = await tx.session.updateMany({
          where: { id: { in: ending }, revokedAt: null },
          data: { revokedAt: now, revokedReason: 'authenticator_reset' },
        });
        await revokePushDevicesForSessions(tx, ending, 'authenticator_reset', now);
        await tx.staffContactChange.updateMany({
          where: { userId: targetUserId, consumedAt: null, cancelledAt: null },
          data: { cancelledAt: now },
        });
        await tx.mfaOtpChallenge.deleteMany({
          where: { audience: 'staff', subjectId: targetUserId },
        });
        await writeAudit(tx, request, {
          action: 'staff.authenticator.reset',
          organisationId: actor.organisationId,
          actorUserId: actor.userId,
          entityType: 'user',
          entityId: targetUserId,
          metadata: { sessionsRevoked: revoked.count },
        });
        await tenantRole(tx, actor.organisationId);
        await tx.staffInvite.updateMany({
          where: { userId: targetUserId, acceptedAt: null, revokedAt: null },
          data: { revokedAt: now },
        });
        const invite = await tx.staffInvite.create({
          data: {
            organisationId: actor.organisationId,
            userId: targetUserId,
            role,
            purpose: 'reset',
            tokenHash: hashToken(token),
            createdByUserId: actor.userId,
            expiresAt: new Date(now.getTime() + INVITE_TTL_MS),
            createdAt: now,
          },
        });
        await writeAudit(tx, request, {
          action: 'staff.reset.link_created',
          organisationId: actor.organisationId,
          actorUserId: actor.userId,
          entityType: 'staff_invite',
          entityId: invite.id,
          metadata: { targetUserId },
        });
        return {
          ...toStaffInvite(invite, user, now),
          inviteUrl: `${this.s.webBaseUrl}/invite#${token}`,
        };
      },
    );
  }
}
