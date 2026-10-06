import {
  STAFF_ROLES,
  type CreatedStaffInvite,
  type ResetAuthenticatorBody,
  type StaffMember,
  type StaffRole,
} from '@dhc/contracts';
import { withAuth, withTenant } from '@dhc/db';
import type { FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';
import { hashToken } from '../../auth/tokens';
import { AppError } from '../../errors';
import type { Services } from '../../services';
import { writeAudit } from '../audit/write';
import { INVITE_TTL_MS, toStaffInvite } from '../invites/service';

interface Actor {
  userId: string;
  organisationId: string;
}

const STAFF = [...STAFF_ROLES];

/** Clinic admin views of staff: who is on the team, and resetting someone's sign-in. */
export class StaffService {
  constructor(private readonly s: Services) {}

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
    const now = this.s.now();

    // Another organisation's staff are invisible here, so they read as not found.
    const roles = (
      await withTenant(this.s.db, actor.organisationId, (tx) =>
        tx.membership.findMany({
          where: { userId: targetUserId, role: { in: STAFF }, status: 'active' },
          select: { role: true },
        }),
      )
    ).map((m) => m.role as StaffRole);
    if (roles.length === 0) throw new AppError(404, 'NOT_FOUND', 'Not found.');
    const role = body.role ?? roles[0]!;
    if (!roles.includes(role)) {
      throw new AppError(400, 'VALIDATION_FAILED', 'This person does not have that role here.', {
        role: roles.join(','),
      });
    }

    const user = await withAuth(this.s.db, async (tx) => {
      // The authenticator belongs to the person, not the clinic. Resetting someone who also
      // works elsewhere would let this clinic take over their access to the other one.
      const elsewhere = await tx.membership.count({
        where: {
          userId: targetUserId,
          role: { in: STAFF },
          status: 'active',
          organisationId: { not: actor.organisationId },
        },
      });
      if (elsewhere > 0) {
        throw new AppError(
          409,
          'CONFLICT',
          'This person also works at another clinic, so their sign-in can only be reset by platform support.',
        );
      }

      const updated = await tx.user.update({
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
      const revoked = await tx.session.updateMany({
        where: { userId: targetUserId, revokedAt: null, role: { not: 'patient' } },
        data: { revokedAt: now, revokedReason: 'authenticator_reset' },
      });
      await writeAudit(tx, request, {
        action: 'staff.authenticator.reset',
        organisationId: actor.organisationId,
        actorUserId: actor.userId,
        entityType: 'user',
        entityId: targetUserId,
        metadata: { sessionsRevoked: revoked.count },
      });
      return updated;
    });

    const token = randomBytes(32).toString('base64url');
    const invite = await withTenant(this.s.db, actor.organisationId, async (tx) => {
      // Only the newest setup link works.
      await tx.staffInvite.updateMany({
        where: { userId: targetUserId, acceptedAt: null, revokedAt: null },
        data: { revokedAt: now },
      });
      const created = await tx.staffInvite.create({
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
        entityId: created.id,
        metadata: { targetUserId },
      });
      return created;
    });

    return {
      ...toStaffInvite(invite, user, now),
      inviteUrl: `${this.s.webBaseUrl}/invite#${token}`,
    };
  }
}
