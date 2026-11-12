import type { PeopleDetail, PeoplePerson, PeopleQuery, UpdatePeopleBody } from '@dhc/contracts';
import { STAFF_ROLES } from '@dhc/contracts';
import { type Tx, type User, type Membership } from '@dhc/db';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../../errors';
import type { Services } from '../../services';
import { writeAudit } from '../audit/write';
import { revokePushDevicesForSessions } from '../devices/revoke';

export interface PeopleActor {
  userId: string;
  organisationId: string;
  sessionId: string;
}
export const authRole = (tx: Tx) => tx.$executeRawUnsafe('SET LOCAL ROLE dhc_auth');
export async function tenantRole(tx: Tx, org: string) {
  await tx.$executeRawUnsafe('SET LOCAL ROLE dhc_app');
  await tx.$executeRaw`SELECT set_config('app.organisation_id', ${org}, true)`;
}
export const notFound = () => new AppError(404, 'NOT_FOUND', 'Not found.');
export const stale = () =>
  new AppError(409, 'CONFLICT', 'This person changed. Reload their details before saving.');
export const identityConflict = () =>
  new AppError(
    409,
    'CONFLICT',
    'Shared staff or patient sign-in details require platform support. Clinic roles and access can still be managed here.',
  );
export async function lockIdentity(tx: Tx, id: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`staff-identity:${id}`}, 0))`;
}
export async function requireLiveActor(s: Services, tx: Tx, actor: PeopleActor, admin: boolean) {
  const session = await tx.session.findUnique({ where: { id: actor.sessionId } });
  const user = await tx.user.findUnique({ where: { id: actor.userId } });
  const org = await tx.organisation.findUnique({ where: { id: actor.organisationId } });
  const membership = await tx.membership.findFirst({
    where: {
      userId: actor.userId,
      organisationId: actor.organisationId,
      status: 'active',
      role: admin ? 'clinic_admin' : { in: [...STAFF_ROLES] },
    },
  });
  if (
    !session ||
    session.revokedAt ||
    session.expiresAt <= s.now() ||
    session.userId !== actor.userId ||
    session.organisationId !== actor.organisationId ||
    session.role === 'patient' ||
    user?.status !== 'active' ||
    org?.status !== 'active' ||
    !membership ||
    (admin && session.role !== 'clinic_admin')
  )
    throw new AppError(401, 'UNAUTHENTICATED', 'Please sign in again.');
}
export async function exclusiveIdentity(tx: Tx, userId: string, org: string): Promise<boolean> {
  return (
    (await tx.membership.count({
      where: { userId, OR: [{ organisationId: { not: org } }, { role: 'patient' }] },
    })) === 0
  );
}
export async function targetRows(tx: Tx, org: string, userId: string) {
  const user = await tx.user.findUnique({ where: { id: userId } });
  const memberships = await tx.membership.findMany({
    where: { organisationId: org, userId, role: { in: [...STAFF_ROLES] } },
    orderBy: { role: 'asc' },
  });
  if (!user || !memberships.length) throw notFound();
  return { user, memberships };
}
export function peopleVersion(s: Services, user: User, memberships: Membership[]) {
  return s.hashOtp(
    'people-version',
    JSON.stringify([
      user.id,
      user.email,
      user.phone,
      user.displayName,
      user.status,
      user.passwordHash,
      user.mfaSecret,
      memberships.map((m) => [m.id, m.role, m.status, m.updatedAt]),
    ]),
  );
}
export function person(
  s: Services,
  user: User,
  memberships: Membership[],
  identityEditable: boolean,
): PeoplePerson {
  const active = memberships.filter((m) => m.status === 'active');
  const invited = memberships.filter((m) => m.status === 'invited');
  const suspended = memberships.filter((m) => m.status === 'suspended');
  const shown = active.length ? active : invited.length ? invited : suspended;
  return {
    userId: user.id,
    displayName: user.displayName,
    email: user.email,
    phone: user.phone,
    roles: shown.map((m) => m.role as PeoplePerson['roles'][number]),
    status:
      user.status !== 'active'
        ? 'disabled'
        : active.length
          ? 'active'
          : invited.length
            ? 'invited'
            : 'disabled',
    identityEditable,
    signInReady:
      user.status === 'active' &&
      !!user.passwordHash &&
      (s.staffMfaMode !== 'totp' || !!user.mfaSecret),
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
  };
}
export async function revokeStaffSessions(
  s: Services,
  tx: Tx,
  userId: string,
  org: string | undefined,
  reason: string,
) {
  const now = s.now();
  const ids = (
    await tx.session.findMany({
      where: {
        userId,
        ...(org ? { organisationId: org } : {}),
        role: { not: 'patient' },
        revokedAt: null,
      },
      select: { id: true },
    })
  ).map((r) => r.id);
  await tx.session.updateMany({
    where: { id: { in: ids }, revokedAt: null },
    data: { revokedAt: now, revokedReason: reason },
  });
  await revokePushDevicesForSessions(tx, ids, reason, now);
}
export class PeopleService {
  constructor(readonly s: Services) {}
  async admin<T>(
    actor: PeopleActor,
    target: string | undefined,
    work: (tx: Tx) => Promise<T>,
  ): Promise<T> {
    return this.s.db.$transaction(async (tx) => {
      await authRole(tx);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`people-admin:${actor.organisationId}`}, 0))`;
      if (target) await lockIdentity(tx, target);
      await requireLiveActor(this.s, tx, actor, true);
      return work(tx);
    });
  }
  async list(actor: PeopleActor, query: PeopleQuery) {
    return this.admin(actor, undefined, async (tx) => {
      const q = query.q?.trim();
      const rows = await tx.user.findMany({
        where: {
          ...(query.cursor ? { id: { gt: query.cursor } } : {}),
          memberships: {
            some: { organisationId: actor.organisationId, role: { in: [...STAFF_ROLES] } },
          },
          ...(q
            ? {
                OR: [
                  { displayName: { contains: q, mode: 'insensitive' as const } },
                  { email: { contains: q, mode: 'insensitive' as const } },
                  { phone: { contains: q } },
                ],
              }
            : {}),
        },
        orderBy: { id: 'asc' },
        take: 51,
      });
      // Cursor uses a stable UUID ordering and is never looked up outside this clinic.
      const visible = rows;
      const data = [];
      for (const user of visible.slice(0, 50)) {
        const memberships = await tx.membership.findMany({
          where: {
            organisationId: actor.organisationId,
            userId: user.id,
            role: { in: [...STAFF_ROLES] },
          },
          orderBy: { role: 'asc' },
        });
        data.push(
          person(
            this.s,
            user,
            memberships,
            await exclusiveIdentity(tx, user.id, actor.organisationId),
          ),
        );
      }
      return { data, nextCursor: visible.length > 50 ? visible[49]!.id : null };
    });
  }
  async detailIn(tx: Tx, actor: PeopleActor, id: string): Promise<PeopleDetail> {
    await authRole(tx);
    const { user, memberships } = await targetRows(tx, actor.organisationId, id);
    const editable = await exclusiveIdentity(tx, id, actor.organisationId);
    await tenantRole(tx, actor.organisationId);
    const audit = await tx.auditLog.findMany({
      where: { entityType: 'user', entityId: id, action: { startsWith: 'staff.' } },
      orderBy: { at: 'desc' },
      take: 30,
      select: { id: true, action: true, at: true, actorUserId: true },
    });
    await authRole(tx);
    const names = new Map(
      (
        await tx.user.findMany({
          where: {
            id: { in: audit.flatMap((a) => (a.actorUserId ? [a.actorUserId] : [])) },
            memberships: {
              some: { organisationId: actor.organisationId, role: { in: [...STAFF_ROLES] } },
            },
          },
          select: { id: true, displayName: true, email: true },
        })
      ).map((u) => [u.id, u.displayName ?? u.email]),
    );
    return {
      ...person(this.s, user, memberships, editable),
      version: peopleVersion(this.s, user, memberships),
      lockedUntil: user.lockedUntil?.toISOString() ?? null,
      authenticatorEnrolled: !!user.mfaSecret,
      secondFactorMode: (user.mfaMode ?? this.s.staffMfaMode) as
        'totp' | 'whatsapp' | 'email' | 'disabled',
      emailVerificationAvailable: !!this.s.emailSender,
      phoneVerificationAvailable: this.s.otpSender.channel === 'whatsapp',
      audit: audit.map((a) => ({
        id: a.id,
        action: a.action,
        at: a.at.toISOString(),
        actorName: a.actorUserId ? (names.get(a.actorUserId) ?? null) : null,
      })),
    };
  }
  get(actor: PeopleActor, id: string) {
    return this.admin(actor, id, (tx) => this.detailIn(tx, actor, id));
  }
  async update(request: FastifyRequest, actor: PeopleActor, id: string, body: UpdatePeopleBody) {
    return this.admin(actor, id, async (tx) => {
      const { user, memberships } = await targetRows(tx, actor.organisationId, id);
      if (peopleVersion(this.s, user, memberships) !== body.version) throw stale();
      if (actor.userId === id && (!body.enabled || !body.roles.includes('clinic_admin')))
        throw new AppError(
          409,
          'CONFLICT',
          'Ask another clinic admin to change your own admin access.',
        );
      const active = memberships.filter((m) => m.status === 'active').map((m) => m.role);
      const roleChanged =
        Boolean(active.length) !== body.enabled ||
        JSON.stringify(person(this.s, user, memberships, false).roles.sort()) !==
          JSON.stringify([...body.roles].sort());
      if (roleChanged && memberships.some((m) => m.status === 'invited'))
        throw new AppError(
          409,
          'CONFLICT',
          'This person must confirm their invitation before roles or access can be changed.',
        );
      if (actor.userId === id && roleChanged)
        throw new AppError(409, 'CONFLICT', 'Ask another clinic admin to change your own roles.');
      if (body.enabled && user.status !== 'active')
        throw new AppError(409, 'CONFLICT', 'This account is disabled. Contact platform support.');
      if (
        body.enabled &&
        (!user.passwordHash || (this.s.staffMfaMode === 'totp' && !user.mfaSecret))
      )
        throw new AppError(
          409,
          'CONFLICT',
          'This person must finish their invitation before access can be enabled or roles changed.',
        );
      if (
        active.includes('clinic_admin') &&
        (!body.enabled || !body.roles.includes('clinic_admin'))
      ) {
        const others = await tx.membership.count({
          where: {
            organisationId: actor.organisationId,
            role: 'clinic_admin',
            status: 'active',
            userId: { not: id },
            user: {
              status: 'active',
              passwordHash: { not: null },
              ...(this.s.staffMfaMode === 'totp' ? { mfaSecret: { not: null } } : {}),
            },
          },
        });
        if (!others) throw new AppError(409, 'CONFLICT', 'Keep at least one active clinic admin.');
      }
      if (user.displayName !== body.displayName) {
        if (!(await exclusiveIdentity(tx, id, actor.organisationId))) throw identityConflict();
        await tx.user.update({ where: { id }, data: { displayName: body.displayName } });
      }
      if (roleChanged) {
        await tenantRole(tx, actor.organisationId);
        await tx.membership.updateMany({
          where: {
            organisationId: actor.organisationId,
            userId: id,
            role: { in: [...STAFF_ROLES] },
          },
          data: { status: 'revoked' },
        });
        for (const role of body.roles)
          await tx.membership.upsert({
            where: {
              organisationId_userId_role: {
                organisationId: actor.organisationId,
                userId: id,
                role,
              },
            },
            create: {
              organisationId: actor.organisationId,
              userId: id,
              role,
              status: body.enabled ? 'active' : 'suspended',
            },
            update: { status: body.enabled ? 'active' : 'suspended' },
          });
        await tx.staffInvite.updateMany({
          where: { userId: id, acceptedAt: null, revokedAt: null },
          data: { revokedAt: this.s.now() },
        });
        await authRole(tx);
        await revokeStaffSessions(this.s, tx, id, actor.organisationId, 'staff_access_changed');
        await tx.staffContactChange.updateMany({
          where: {
            organisationId: actor.organisationId,
            userId: id,
            consumedAt: null,
            cancelledAt: null,
          },
          data: { cancelledAt: this.s.now() },
        });
      }
      await writeAudit(tx, request, {
        action: 'staff.people.updated',
        organisationId: actor.organisationId,
        actorUserId: actor.userId,
        entityType: 'user',
        entityId: id,
        metadata: {
          nameChanged: user.displayName !== body.displayName,
          accessChanged: roleChanged,
          enabled: body.enabled,
          roles: body.roles,
        },
      });
      return this.detailIn(tx, actor, id);
    });
  }
}
