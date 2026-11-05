import { requirePatientAccountOpen } from '../data-rights/access';
import { PhoneChangeView, type StartPhoneChange, type VerifyPhoneChange } from '@dhc/contracts';
import { withAuth, withTenant, type Tx } from '@dhc/db';
import type { FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { normaliseIndianMobile } from '../../auth/phone';
import { AppError } from '../../errors';
import type { Services } from '../../services';
import { AuthService } from '../auth/service';
import { writeAudit } from '../audit/write';
import { revokePushDevicesForSessions } from '../devices/revoke';
import { accountPhone } from './account';
import { PortalProfileService, adultAt } from './profile';

type Actor = { userId: string; organisationId: string };
const missing = () => new AppError(404, 'NOT_FOUND', 'Not found.');
const invalid = () =>
  new AppError(400, 'VALIDATION_FAILED', 'The verification codes are invalid or expired.', {
    code: 'invalid',
  });
const review = () =>
  new AppError(409, 'CONFLICT', 'Please visit the clinic to verify this phone change.', {
    phone: 'clinic_review',
  });
const same = (a: string, b: string) => {
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
const out = (r: {
  id: string;
  expiresAt: Date;
  completedAt: Date | null;
  oldChallengeId: string | null;
  newChallengeId: string | null;
}) =>
  PhoneChangeView.parse({
    id: r.id,
    expiresAt: r.expiresAt.toISOString(),
    completed: !!r.completedAt,
    ready: !!(r.oldChallengeId && r.newChallengeId),
  });

/** Clinical rows stay under the tenant role; identity proofs stay under the auth role.
 * Role switches occur in one owner-started transaction, never from caller input.
 */
async function tenant<T>(tx: Tx, actor: Actor, run: () => Promise<T>) {
  await tx.$executeRawUnsafe('SET LOCAL ROLE dhc_app');
  await tx.$executeRaw`SELECT set_config('app.organisation_id', ${actor.organisationId}, true)`;
  try {
    return await run();
  } finally {
    await tx.$executeRawUnsafe('SET LOCAL ROLE dhc_auth');
  }
}
export class PatientPhoneChangeService {
  constructor(private readonly s: Services) {}
  async start(request: FastifyRequest, actor: Actor, patientId: string, body: StartPhoneChange) {
    const oldPhone = await accountPhone(this.s, actor.userId);
    const newPhone = normaliseIndianMobile(body.newPhone);
    if (!newPhone || newPhone === oldPhone)
      throw new AppError(
        400,
        'VALIDATION_FAILED',
        'Enter a different valid Indian mobile number.',
        { newPhone: 'invalid' },
      );
    const profile = new PortalProfileService(this.s);
    await withTenant(this.s.db, actor.organisationId, async (tx) => {
      const p = await profile.owned(tx, actor, patientId, oldPhone);
      if (p.phone !== oldPhone || p.guardianPatientId || !adultAt(p.dob, this.s.now()))
        throw review();
    });
    const prior = await withAuth(this.s.db, (tx) =>
      tx.patientPhoneChange.findUnique({ where: { id: body.id } }),
    );
    if (prior) {
      if (
        prior.userId !== actor.userId ||
        prior.organisationId !== actor.organisationId ||
        prior.patientId !== patientId ||
        prior.newPhone !== newPhone
      )
        throw missing();
      return out(prior); // A retry never sends a second pair of codes.
    }
    const prepared = await withAuth(this.s.db, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`phone-change-user:${actor.userId}`}, 0))`;
      const existing = await tx.patientPhoneChange.findUnique({ where: { id: body.id } });
      if (existing) {
        if (
          existing.userId !== actor.userId ||
          existing.organisationId !== actor.organisationId ||
          existing.patientId !== patientId ||
          existing.newPhone !== newPhone
        )
          throw missing();
        return { existing, org: null };
      }
      const recent = await tx.patientPhoneChange.count({
        where: {
          userId: actor.userId,
          createdAt: { gt: new Date(this.s.now().getTime() - 3600000) },
        },
      });
      if (recent >= 3)
        throw new AppError(429, 'RATE_LIMITED', 'Too many phone change requests. Try later.');
      const org = await tx.organisation.findUniqueOrThrow({ where: { id: actor.organisationId } });
      await tx.patientPhoneChange.create({
        data: {
          id: body.id,
          organisationId: actor.organisationId,
          userId: actor.userId,
          patientId,
          oldPhone,
          newPhone,
          createdAt: this.s.now(),
          expiresAt: new Date(this.s.now().getTime() + 300000),
        },
      });
      return { existing: null, org };
    });
    if (prepared.existing) return out(prepared.existing);
    const org = prepared.org!;
    const auth = new AuthService(this.s);
    const old = await auth.requestOtp(request, org.slug, oldPhone, 'phone_change');
    const next = await auth.requestOtp(request, org.slug, newPhone, 'phone_change');
    return withAuth(this.s.db, async (tx) => {
      await tx.patientPhoneChange.update({
        where: { id: body.id },
        data: {
          oldChallengeId: old.challengeId,
          newChallengeId: next.challengeId,
          expiresAt: new Date(Math.min(Date.parse(old.expiresAt), Date.parse(next.expiresAt))),
        },
      });
      const r = await tx.patientPhoneChange.findUniqueOrThrow({ where: { id: body.id } });
      if (
        r.userId !== actor.userId ||
        r.organisationId !== actor.organisationId ||
        r.patientId !== patientId ||
        r.newPhone !== newPhone
      )
        throw missing();
      await writeAudit(tx, request, {
        action: 'patient.phone_change_requested',
        organisationId: actor.organisationId,
        actorUserId: actor.userId,
        entityType: 'patient',
        entityId: patientId,
      });
      return out(r);
    });
  }
  async verify(request: FastifyRequest, actor: Actor, id: string, body: VerifyPhoneChange) {
    const outcome = await withAuth(this.s.db, async (tx) => {
      await tx.$queryRaw`SELECT id FROM patient_phone_changes WHERE id=${id}::uuid FOR UPDATE`;
      const r = await tx.patientPhoneChange.findUnique({ where: { id } });
      if (!r || r.userId !== actor.userId || r.organisationId !== actor.organisationId)
        throw missing();
      const now = this.s.now();
      if (r.completedAt) return { kind: 'ok' as const, view: out(r) };
      if (!r.oldChallengeId || !r.newChallengeId || r.expiresAt <= now)
        return { kind: 'invalid' as const };
      // Shared with sign-in's identity creation; competing transfers cannot join accounts.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`auth-phone:${r.newPhone}`}, 0))`;
      // Lock challenges as well: proofs are single-use and cannot authorize two changes.
      await tx.$queryRaw`SELECT id FROM otp_challenges WHERE id IN (${r.oldChallengeId}::uuid,${r.newChallengeId}::uuid) ORDER BY id FOR UPDATE`;
      const old = await tx.otpChallenge.findUnique({ where: { id: r.oldChallengeId } });
      const next = await tx.otpChallenge.findUnique({ where: { id: r.newChallengeId } });
      let valid = true;
      for (const [c, phone, code] of [
        [old, r.oldPhone, body.oldCode],
        [next, r.newPhone, body.newCode],
      ] as const) {
        if (
          !c ||
          c.phone !== phone ||
          c.organisationId !== actor.organisationId ||
          c.purpose !== 'phone_change' ||
          c.consumedAt ||
          c.expiresAt <= now ||
          c.attempts >= 5
        ) {
          valid = false;
          continue;
        }
        if (!same(this.s.hashOtp(c.id, code), c.codeHash)) {
          valid = false;
          await tx.otpChallenge.update({
            where: { id: c.id },
            data: { attempts: { increment: 1 } },
          });
        }
      }
      if (!valid) {
        await writeAudit(tx, request, {
          action: 'patient.phone_change_failed',
          organisationId: actor.organisationId,
          actorUserId: actor.userId,
          entityType: 'patient',
          entityId: r.patientId,
        });
        return { kind: 'invalid' as const };
      }
      const source = await tx.user.findUnique({ where: { id: actor.userId } });
      const org = await tx.organisation.findUnique({ where: { id: actor.organisationId } });
      if (source?.phone !== r.oldPhone || source.status !== 'active' || org?.status !== 'active')
        return { kind: 'review' as const };
      const sourceMember = await tx.membership.findUnique({
        where: {
          organisationId_userId_role: {
            organisationId: actor.organisationId,
            userId: actor.userId,
            role: 'patient',
          },
        },
      });
      if (sourceMember?.status !== 'active') return { kind: 'review' as const };
      const target = await tx.user.findUnique({ where: { phone: r.newPhone } });
      if (target && target.status !== 'active') return { kind: 'review' as const };
      const member = target
        ? await tx.membership.findUnique({
            where: {
              organisationId_userId_role: {
                organisationId: actor.organisationId,
                userId: target.id,
                role: 'patient',
              },
            },
          })
        : null;
      if (
        target &&
        (
          await tx.patientAccountAccess.findUnique({
            where: {
              organisationId_userId: { organisationId: actor.organisationId, userId: target.id },
            },
          })
        )?.closedAt
      )
        return { kind: 'review' as const };
      if (member && member.status !== 'active') return { kind: 'review' as const };
      const eligible = await tenant(tx, actor, async () => {
        await tx.$queryRaw`SELECT id FROM patients WHERE id=${r.patientId}::uuid FOR UPDATE`;
        const p = await new PortalProfileService(this.s).owned(tx, actor, r.patientId, r.oldPhone);
        return (
          p.phone === r.oldPhone &&
          !p.guardianPatientId &&
          adultAt(p.dob, now) &&
          (await tx.patient.count({ where: { phone: r.newPhone } })) === 0
        );
      });
      if (!eligible) return { kind: 'review' as const };
      const destination = target ?? (await tx.user.create({ data: { phone: r.newPhone } }));
      if (!member)
        await tx.membership.create({
          data: { userId: destination.id, organisationId: actor.organisationId, role: 'patient' },
        });
      await tx.patientAccountAccess.upsert({
        where: {
          organisationId_userId: { organisationId: actor.organisationId, userId: destination.id },
        },
        create: { organisationId: actor.organisationId, userId: destination.id },
        update: {},
      });
      await tenant(tx, actor, async () => {
        await requirePatientAccountOpen(tx, { ...actor, userId: destination.id });
        // The original row lock remains held across role switches until commit.
        await tx.patient.update({
          where: { id: r.patientId },
          data: { phone: r.newPhone, accountUserId: destination.id },
        });
        await tx.patient.updateMany({
          where: { guardianPatientId: r.patientId, phone: null, mergedIntoId: null },
          data: { accountUserId: destination.id },
        });
        await writeAudit(tx, request, {
          action: 'patient.phone_changed',
          organisationId: actor.organisationId,
          actorUserId: actor.userId,
          entityType: 'patient',
          entityId: r.patientId,
          metadata: { scope: 'selected_adult_and_dependants', verification: 'old_and_new_otp' },
        });
      });
      await tx.otpChallenge.updateMany({
        where: { id: { in: [r.oldChallengeId, r.newChallengeId] } },
        data: { consumedAt: now },
      });
      const sessions = await tx.session.findMany({
        where: {
          organisationId: actor.organisationId,
          role: 'patient',
          userId: { in: [actor.userId, destination.id] },
          revokedAt: null,
        },
        select: { id: true },
      });
      await revokePushDevicesForSessions(
        tx,
        sessions.map((s) => s.id),
        'phone_changed',
        now,
      );
      await tx.session.updateMany({
        where: { id: { in: sessions.map((s) => s.id) } },
        data: { revokedAt: now, revokedReason: 'phone_changed' },
      });
      const done = await tx.patientPhoneChange.update({
        where: { id },
        data: { completedAt: now },
      });
      return { kind: 'ok' as const, view: out(done) };
    });
    if (outcome.kind === 'invalid') throw invalid();
    if (outcome.kind === 'review') throw review();
    return outcome.view;
  }
}
