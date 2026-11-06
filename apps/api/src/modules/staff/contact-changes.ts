import { z } from 'zod';
import type {
  RequestStaffContactBody,
  StaffContactChange,
  ConfirmStaffContactBody,
} from '@dhc/contracts';
import { withAuth, type Tx, type StaffContactChange as Row } from '@dhc/db';
import { randomUUID, randomInt, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { verifyPassword, DUMMY_PASSWORD_HASH } from '../../auth/password';
import { normaliseIndianMobile } from '../../auth/phone';
import { AppError } from '../../errors';
import { writeAudit } from '../audit/write';
import { recordFailure, LOCKED } from '../auth/service';
import {
  PeopleService,
  type PeopleActor,
  authRole,
  tenantRole,
  lockIdentity,
  requireLiveActor,
  targetRows,
  peopleVersion,
  exclusiveIdentity,
  identityConflict,
  stale,
  notFound,
  revokeStaffSessions,
} from './people';

const unavailable = () =>
  new AppError(
    503,
    'UNAVAILABLE',
    'Verification delivery is not configured. Contact your administrator.',
  );
const invalidCode = () =>
  new AppError(400, 'VALIDATION_FAILED', 'The verification code is invalid or has expired.', {
    code: 'invalid',
  });
export class StaffContactService extends PeopleService {
  out(row: Row): StaffContactChange {
    return {
      id: row.id,
      field: row.field as 'email' | 'phone',
      destination: this.s.cipher.decrypt(row.encryptedValue),
      expiresAt: row.expiresAt.toISOString(),
      state: row.consumedAt
        ? 'completed'
        : row.cancelledAt
          ? row.deliveredAt
            ? 'cancelled'
            : 'delivery_failed'
          : row.expiresAt <= this.s.now()
            ? 'expired'
            : row.deliveredAt
              ? 'pending'
              : 'delivery_failed',
    };
  }
  async listChanges(actor: PeopleActor, targetId?: string) {
    const work = async (tx: Tx) => ({
      data: (
        await tx.staffContactChange.findMany({
          where: { organisationId: actor.organisationId, userId: targetId ?? actor.userId },
          orderBy: { createdAt: 'desc' },
          take: 10,
        })
      ).map((r) => this.out(r)),
    });
    if (targetId)
      return this.admin(actor, targetId, async (tx) => {
        await targetRows(tx, actor.organisationId, targetId);
        return work(tx);
      });
    return withAuth(this.s.db, async (tx) => {
      await requireLiveActor(this.s, tx, actor, false);
      return work(tx);
    });
  }
  async password(userId: string, password: string) {
    const user = await withAuth(this.s.db, (tx) => tx.user.findUnique({ where: { id: userId } }));
    const hash = user?.passwordHash;
    return { hash, ok: await verifyPassword(password, hash ?? DUMMY_PASSWORD_HASH) };
  }
  async request(
    request: FastifyRequest,
    actor: PeopleActor,
    id: string,
    body: RequestStaffContactBody,
  ) {
    const checked = await this.password(actor.userId, body.password);
    const now = this.s.now();
    const value =
      body.field === 'email' ? body.value.toLowerCase() : normaliseIndianMobile(body.value);
    if (!value || (body.field === 'email' && !z.email().max(254).safeParse(value).success))
      throw new AppError(
        400,
        'VALIDATION_FAILED',
        'Enter a valid email address or Indian mobile number.',
      );
    if (body.field === 'email' && !this.s.emailSender) throw unavailable();
    if (body.field === 'phone' && this.s.otpSender.channel !== 'whatsapp') throw unavailable();
    const code = String(randomInt(0, 1000000)).padStart(6, '0');
    const outcome = await this.admin(actor, id, async (tx) => {
      const caller = await tx.user.findUniqueOrThrow({ where: { id: actor.userId } });
      if (caller.lockedUntil && caller.lockedUntil > now) return { error: LOCKED() };
      if (!checked.ok || caller.passwordHash !== checked.hash) {
        await recordFailure(tx, caller.id, now);
        await writeAudit(tx, request, {
          action: 'staff.contact.reauth_failed',
          organisationId: actor.organisationId,
          actorUserId: actor.userId,
          entityType: 'user',
          entityId: actor.userId,
        });
        return {
          error: new AppError(400, 'VALIDATION_FAILED', 'Check your administrator password.', {
            password: 'invalid',
          }),
        };
      }
      const { user, memberships } = await targetRows(tx, actor.organisationId, id);
      if (peopleVersion(this.s, user, memberships) !== body.version) throw stale();
      if (!memberships.some((m) => m.status === 'active') || user.status !== 'active')
        throw new AppError(
          409,
          'CONFLICT',
          'Enable this staff member before changing sign-in details.',
        );
      if (!(await exclusiveIdentity(tx, id, actor.organisationId))) throw identityConflict();
      if (user[body.field] === value)
        throw new AppError(400, 'VALIDATION_FAILED', 'That is already the current sign-in detail.');
      if (body.field === 'phone' && user.email && this.s.staffMfaPhones[user.email.toLowerCase()])
        throw new AppError(
          409,
          'CONFLICT',
          'Ask the server owner to update this account’s second-factor phone mapping first.',
        );
      if (body.field === 'email' && this.s.staffMfaMode === 'whatsapp' && !user.phone)
        throw new AppError(
          409,
          'CONFLICT',
          'Verify an account mobile number before changing an email used for WhatsApp second-factor delivery.',
        );
      if (await tx.user.findFirst({ where: { [body.field]: value, id: { not: id } } }))
        throw new AppError(
          409,
          'CONFLICT',
          'That sign-in detail cannot be assigned. Contact platform support.',
        );
      if (
        (await tx.staffContactChange.count({
          where: {
            organisationId: actor.organisationId,
            userId: id,
            createdAt: { gt: new Date(now.getTime() - 10 * 60000) },
          },
        })) >= 3
      )
        throw new AppError(429, 'RATE_LIMITED', 'Too many verification requests. Try again later.');
      await tx.staffContactChange.updateMany({
        where: {
          organisationId: actor.organisationId,
          userId: id,
          field: body.field,
          consumedAt: null,
          cancelledAt: null,
        },
        data: { cancelledAt: now },
      });
      const changeId = randomUUID();
      const row = await tx.staffContactChange.create({
        data: {
          id: changeId,
          organisationId: actor.organisationId,
          userId: id,
          actorUserId: actor.userId,
          field: body.field,
          encryptedValue: this.s.cipher.encrypt(value),
          version: body.version,
          codeHash: this.s.hashOtp(changeId, code),
          createdAt: now,
          expiresAt: new Date(now.getTime() + 10 * 60000),
        },
      });
      await writeAudit(tx, request, {
        action: 'staff.contact.requested',
        organisationId: actor.organisationId,
        actorUserId: actor.userId,
        entityType: 'user',
        entityId: id,
        metadata: { changeId, field: body.field },
      });
      return { row };
    });
    if ('error' in outcome) throw outcome.error;
    try {
      if (body.field === 'email') await this.s.emailSender!.sendVerification(value, code);
      else await this.s.otpSender.send(value, code);
      const delivered = await withAuth(this.s.db, (tx) =>
        tx.staffContactChange.update({
          where: { id: outcome.row.id },
          data: { deliveredAt: this.s.now() },
        }),
      );
      return this.out(delivered);
    } catch {
      await withAuth(this.s.db, (tx) =>
        tx.staffContactChange.update({
          where: { id: outcome.row.id },
          data: { cancelledAt: this.s.now() },
        }),
      );
      throw new AppError(
        503,
        'UNAVAILABLE',
        'Verification could not be sent. The sign-in detail has not changed.',
      );
    }
  }
  async cancel(request: FastifyRequest, actor: PeopleActor, id: string, changeId: string) {
    return this.admin(actor, id, async (tx) => {
      await targetRows(tx, actor.organisationId, id);
      const row = await tx.staffContactChange.findFirst({
        where: { id: changeId, userId: id, organisationId: actor.organisationId },
      });
      if (!row) throw notFound();
      if (row.consumedAt) throw new AppError(409, 'CONFLICT', 'This change was already completed.');
      await tx.staffContactChange.update({
        where: { id: changeId },
        data: { cancelledAt: this.s.now() },
      });
      await writeAudit(tx, request, {
        action: 'staff.contact.cancelled',
        organisationId: actor.organisationId,
        actorUserId: actor.userId,
        entityType: 'user',
        entityId: id,
        metadata: { changeId },
      });
    });
  }
  async confirm(
    request: FastifyRequest,
    actor: PeopleActor,
    id: string,
    body: ConfirmStaffContactBody,
  ) {
    const checked = await this.password(actor.userId, body.password);
    const now = this.s.now();
    const outcome = await this.s.db
      .$transaction(async (tx) => {
        await authRole(tx);
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`people-admin:${actor.organisationId}`}, 0))`;
        await lockIdentity(tx, actor.userId);
        await requireLiveActor(this.s, tx, actor, false);
        const { user, memberships } = await targetRows(tx, actor.organisationId, actor.userId);
        if (user.lockedUntil && user.lockedUntil > now) return { error: LOCKED() };
        const row = await tx.staffContactChange.findFirst({
          where: { id, userId: user.id, organisationId: actor.organisationId },
        });
        if (!row) throw notFound();
        if (
          row.consumedAt ||
          row.cancelledAt ||
          !row.deliveredAt ||
          row.expiresAt <= now ||
          row.attempts >= 5
        )
          return { error: invalidCode() };
        if (!checked.ok || user.passwordHash !== checked.hash) {
          await recordFailure(tx, user.id, now);
          await writeAudit(tx, request, {
            action: 'staff.contact.reauth_failed',
            organisationId: actor.organisationId,
            actorUserId: actor.userId,
            entityType: 'user',
            entityId: user.id,
          });
          return {
            error: new AppError(400, 'VALIDATION_FAILED', 'Check your current password.', {
              password: 'invalid',
            }),
          };
        }
        if (
          !timingSafeEqual(
            Buffer.from(row.codeHash),
            Buffer.from(this.s.hashOtp(row.id, body.code)),
          )
        ) {
          await tx.staffContactChange.update({
            where: { id },
            data: { attempts: { increment: 1 } },
          });
          await recordFailure(tx, user.id, now);
          await writeAudit(tx, request, {
            action: 'staff.contact.code_failed',
            organisationId: actor.organisationId,
            actorUserId: actor.userId,
            entityType: 'user',
            entityId: user.id,
            metadata: { changeId: id },
          });
          return { error: invalidCode() };
        }
        const creator = await tx.membership.findFirst({
          where: {
            organisationId: actor.organisationId,
            userId: row.actorUserId,
            role: 'clinic_admin',
            status: 'active',
            user: { status: 'active' },
          },
        });
        if (!creator || peopleVersion(this.s, user, memberships) !== row.version) throw stale();
        if (!(await exclusiveIdentity(tx, user.id, actor.organisationId))) throw identityConflict();
        const value = this.s.cipher.decrypt(row.encryptedValue);
        if (row.field === 'phone' && user.email && this.s.staffMfaPhones[user.email.toLowerCase()])
          throw identityConflict();
        const updated = await tx.user.updateMany({
          where: {
            id: user.id,
            status: 'active',
            passwordHash: checked.hash,
            failedLoginCount: user.failedLoginCount,
            OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }],
          },
          data: { [row.field]: value, failedLoginCount: 0, lockedUntil: null },
        });
        if (updated.count !== 1) throw stale();
        await tx.staffContactChange.update({ where: { id }, data: { consumedAt: now } });
        await tx.staffContactChange.updateMany({
          where: { userId: user.id, id: { not: id }, consumedAt: null, cancelledAt: null },
          data: { cancelledAt: now },
        });
        await tx.mfaOtpChallenge.deleteMany({ where: { audience: 'staff', subjectId: user.id } });
        await revokeStaffSessions(this.s, tx, user.id, undefined, 'staff_identity_changed');
        await tenantRole(tx, actor.organisationId);
        await tx.staffInvite.updateMany({
          where: { userId: user.id, acceptedAt: null, revokedAt: null },
          data: { revokedAt: now },
        });
        await writeAudit(tx, request, {
          action: 'staff.contact.confirmed',
          organisationId: actor.organisationId,
          actorUserId: user.id,
          entityType: 'user',
          entityId: user.id,
          metadata: { changeId: id, field: row.field },
        });
        return { updated: true as const };
      })
      .catch((error) => {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002')
          throw new AppError(
            409,
            'CONFLICT',
            'That sign-in detail cannot be assigned. Contact platform support.',
          );
        throw error;
      });
    if ('error' in outcome) throw outcome.error;
    return outcome;
  }
}
