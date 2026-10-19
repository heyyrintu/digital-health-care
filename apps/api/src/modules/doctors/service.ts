import type {
  DoctorProfile,
  Role,
  SaveDoctorProfileBody,
  SaveDoctorPublicProfileBody,
  SetSigningPinBody,
} from '@dhc/contracts';
import { Prisma, withAuth, withTenant, type Tx } from '@dhc/db';
import type { FastifyRequest } from 'fastify';
import { hashPassword, verifyPassword } from '../../auth/password';
import { AppError } from '../../errors';
import type { Services } from '../../services';
import { writeAudit } from '../audit/write';

interface Actor {
  userId: string;
  organisationId: string;
  role: Role;
}

type ProfileRow = Prisma.DoctorProfileGetPayload<object>;

/** Wrong PINs allowed in a row before signing pauses. */
export const PIN_ATTEMPTS = 5;
export const PIN_LOCK_MS = 15 * 60_000;

/** What stops a doctor signing, apart from the safety alerts. */
export type SigningGap = 'profile' | 'verification' | 'pin' | 'service';

export function signingGaps(profile: ProfileRow | null, signerReady: boolean): SigningGap[] {
  const gaps: SigningGap[] = [];
  if (
    !profile?.registrationNumber ||
    !profile.council ||
    !profile.qualifications ||
    !profile.rxPrefix
  ) {
    gaps.push('profile');
  }
  if (profile?.verification !== 'verified') gaps.push('verification');
  if (!profile?.signingPinHash) gaps.push('pin');
  if (!signerReady) gaps.push('service');
  return gaps;
}

/** The constraint a database error names (Prisma's driver adapter puts it in `meta`). */
export function violatedConstraint(error: unknown): string | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return null;
  const meta = JSON.stringify(error.meta ?? {});
  return /(doctor_profiles_[a-z_]+?_(?:key|check))/.exec(meta)?.[1] ?? null;
}

/** The database's CHECK constraints on the public page, by the field they guard. */
const PUBLIC_CHECKS: Record<string, [field: string, code: string]> = {
  doctor_profiles_public_slug_check: ['slug', 'invalid'],
  doctor_profiles_about_check: ['about', 'invalid'],
  doctor_profiles_languages_check: ['languages', 'invalid'],
  doctor_profiles_listed_slug_check: ['slug', 'required'],
};

/**
 * What a refused public-page save means for the doctor. Only the address's own unique
 * index is "taken" (who holds it, here or elsewhere, is not said); a CHECK the contract did
 * not catch is a 400 on its field. Anything else is not the doctor's to fix and is rethrown.
 */
export function publicSaveError(error: unknown): unknown {
  const constraint = violatedConstraint(error);
  if (constraint === 'doctor_profiles_public_slug_key') {
    return new AppError(409, 'CONFLICT', 'That page address is taken.', { slug: 'taken' });
  }
  const check = constraint ? PUBLIC_CHECKS[constraint] : undefined;
  if (check) {
    return new AppError(400, 'VALIDATION_FAILED', 'Check the public page fields.', {
      [check[0]]: check[1],
    });
  }
  return error;
}

export const findProfile = (tx: Tx, actor: { organisationId: string; userId: string }) =>
  tx.doctorProfile.findUnique({
    where: {
      organisationId_userId: { organisationId: actor.organisationId, userId: actor.userId },
    },
  });

/**
 * A doctor's prescription pad and signing details (PRD §9.1). The doctor fills them in;
 * the platform team verifies the registration (support command); the PIN approves each
 * signature on the web.
 */
export class DoctorProfileService {
  constructor(private readonly s: Services) {}

  async get(actor: Actor): Promise<DoctorProfile> {
    const row = await withTenant(this.s.db, actor.organisationId, (tx) => findProfile(tx, actor));
    return this.out(row);
  }

  /**
   * Saves the details. Changing the registration number or council sends the profile back
   * to the platform team for verification.
   */
  async save(
    request: FastifyRequest,
    actor: Actor,
    body: SaveDoctorProfileBody,
  ): Promise<DoctorProfile> {
    return withTenant(this.s.db, actor.organisationId, async (tx) => {
      const existing = await findProfile(tx, actor);
      // Numbers run per doctor, so a prefix another doctor has printed could repeat theirs.
      if (existing?.rxPrefix !== body.rxPrefix) {
        const used = await tx.prescription.count({
          where: {
            number: { startsWith: `${body.rxPrefix}-` },
            doctorUserId: { not: actor.userId },
          },
        });
        if (used > 0) {
          throw new AppError(
            409,
            'CONFLICT',
            'That prefix is already on another doctor’s prescriptions.',
            {
              rxPrefix: 'taken',
            },
          );
        }
      }
      const registrationChanged =
        !!existing &&
        (existing.registrationNumber !== body.registrationNumber ||
          existing.council !== body.council);
      // Only for the audit entry: a verified registration went back to the queue.
      const reverify = existing?.verification === 'verified' && registrationChanged;
      const data = {
        registrationNumber: body.registrationNumber,
        council: body.council,
        qualifications: body.qualifications,
        specialty: body.specialty || null,
        rxPrefix: body.rxPrefix,
        paperSize: body.paperSize,
        // Back in the platform team's queue, as of now, whatever its state: a check of the
        // old details (finished, or one in progress) no longer applies.
        ...(registrationChanged
          ? {
              submittedAt: this.s.now(),
              verification: 'pending' as const,
              verifiedAt: null,
              verifiedBy: null,
            }
          : {}),
      };
      let row: ProfileRow;
      try {
        row = existing
          ? await tx.doctorProfile.update({ where: { id: existing.id }, data })
          : await tx.doctorProfile.create({
              data: {
                ...data,
                organisationId: actor.organisationId,
                userId: actor.userId,
                submittedAt: this.s.now(),
              },
            });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          throw new AppError(409, 'CONFLICT', 'Another doctor here uses that prefix.', {
            rxPrefix: 'taken',
          });
        }
        throw error;
      }
      await writeAudit(tx, request, {
        action: 'doctor.profile_saved',
        organisationId: actor.organisationId,
        actorUserId: actor.userId,
        entityType: 'doctor_profile',
        entityId: row.id,
        metadata: { reverify },
      });
      return this.out(row);
    });
  }

  /**
   * Sets the public page (ADR 0017): its address, whether it is listed, the about text and
   * languages. Only the fields sent change. The address is unique across organisations; the
   * page shows only once the registration is verified.
   */
  async savePublic(
    request: FastifyRequest,
    actor: Actor,
    body: SaveDoctorPublicProfileBody,
  ): Promise<DoctorProfile> {
    return withTenant(this.s.db, actor.organisationId, async (tx) => {
      const existing = await findProfile(tx, actor);
      const before = {
        slug: existing?.publicSlug ?? null,
        listed: existing?.listed ?? false,
        about: existing?.about ?? null,
        languages: existing?.languages ?? [],
      };
      const after = {
        slug: body.slug !== undefined ? body.slug : before.slug,
        listed: body.listed ?? before.listed,
        about: body.about !== undefined ? body.about : before.about,
        languages: body.languages ?? before.languages,
      };
      if (after.listed && !after.slug) {
        throw new AppError(400, 'VALIDATION_FAILED', 'Choose a page address to list the page.', {
          slug: 'required',
        });
      }
      // Field names only, never their values, in the audit entry.
      const changed = (Object.keys(after) as (keyof typeof after)[]).filter(
        (key) => JSON.stringify(after[key]) !== JSON.stringify(before[key]),
      );
      if (changed.length === 0) return this.out(existing);
      const data = {
        publicSlug: after.slug,
        listed: after.listed,
        about: after.about,
        languages: after.languages,
        publicUpdatedAt: this.s.now(),
      };
      let row: ProfileRow;
      try {
        row = existing
          ? await tx.doctorProfile.update({ where: { id: existing.id }, data })
          : await tx.doctorProfile.create({
              data: { ...data, organisationId: actor.organisationId, userId: actor.userId },
            });
      } catch (error) {
        throw publicSaveError(error);
      }
      await writeAudit(tx, request, {
        action: 'doctor_profile.public_updated',
        organisationId: actor.organisationId,
        actorUserId: actor.userId,
        entityType: 'doctor_profile',
        entityId: row.id,
        metadata: { fields: changed },
      });
      return this.out(row);
    });
  }

  /** Sets or changes the signing PIN after checking the account password. */
  async setPin(request: FastifyRequest, actor: Actor, body: SetSigningPinBody): Promise<void> {
    const user = await withAuth(this.s.db, (tx) =>
      tx.user.findUnique({ where: { id: actor.userId }, select: { passwordHash: true } }),
    );
    if (!user?.passwordHash || !(await verifyPassword(body.password, user.passwordHash))) {
      throw new AppError(400, 'VALIDATION_FAILED', 'That password is not right.', {
        password: 'wrong',
      });
    }
    const hash = await hashPassword(this.s.pepperPin(actor.userId, body.pin));
    await withTenant(this.s.db, actor.organisationId, async (tx) => {
      const existing = await findProfile(tx, actor);
      const data = { signingPinHash: hash, pinFailedCount: 0, pinLockedUntil: null };
      const row = existing
        ? await tx.doctorProfile.update({ where: { id: existing.id }, data })
        : await tx.doctorProfile.create({
            data: { ...data, organisationId: actor.organisationId, userId: actor.userId },
          });
      await writeAudit(tx, request, {
        action: 'doctor.signing_pin_set',
        organisationId: actor.organisationId,
        actorUserId: actor.userId,
        entityType: 'doctor_profile',
        entityId: row.id,
      });
    });
  }

  /**
   * Checks the signing PIN in its own transaction, so a wrong attempt is counted even
   * though the signing that asked for it does not go ahead. Five wrong in a row pause
   * signing for 15 minutes.
   */
  async checkPin(request: FastifyRequest, actor: Actor, pin: string): Promise<void> {
    const now = this.s.now();
    const found = await withTenant(this.s.db, actor.organisationId, async (tx) => {
      const profile = await findProfile(tx, actor);
      if (!profile?.signingPinHash) return 'unset' as const;
      if (profile.pinLockedUntil && profile.pinLockedUntil > now) return 'locked' as const;
      return { checkedHash: profile.signingPinHash };
    });
    // The PIN is checked between transactions: scrypt is slow by design, and on a busy CPU
    // it can outlast the interactive-transaction timeout (a 500) while holding a pooled
    // connection.
    const outcome =
      typeof found === 'object'
        ? await this.settlePin(request, actor, pin, found.checkedHash)
        : found;
    if (outcome === 'unset') {
      throw new AppError(422, 'BUSINESS_RULE', 'Set a signing PIN in your profile first.', {
        pin: 'unset',
      });
    }
    if (outcome === 'locked') {
      throw new AppError(429, 'RATE_LIMITED', 'Too many wrong PINs. Try again in 15 minutes.', {
        pin: 'locked',
      });
    }
    if (outcome === 'wrong') {
      throw new AppError(400, 'VALIDATION_FAILED', 'That PIN is not right.', { pin: 'wrong' });
    }
  }

  /** Checks the PIN with no transaction open, then records the result against a re-read profile. */
  private async settlePin(
    request: FastifyRequest,
    actor: Actor,
    pin: string,
    checkedHash: string,
  ): Promise<'unset' | 'locked' | 'ok' | 'wrong'> {
    const now = this.s.now();
    const pinOk = await verifyPassword(this.s.pepperPin(actor.userId, pin), checkedHash);
    return withTenant(this.s.db, actor.organisationId, async (tx) => {
      // Re-read: the PIN, lock and failure count may have changed during the check.
      const profile = await findProfile(tx, actor);
      if (!profile?.signingPinHash) return 'unset' as const;
      if (profile.pinLockedUntil && profile.pinLockedUntil > now) return 'locked' as const;
      if (pinOk && profile.signingPinHash === checkedHash) {
        if (profile.pinFailedCount > 0) {
          await tx.doctorProfile.update({ where: { id: profile.id }, data: { pinFailedCount: 0 } });
        }
        return 'ok' as const;
      }
      // A PIN changed meanwhile counts as a wrong attempt.
      const updated = await tx.doctorProfile.update({
        where: { id: profile.id },
        data: { pinFailedCount: { increment: 1 } },
      });
      if (updated.pinFailedCount < PIN_ATTEMPTS) return 'wrong' as const;
      await tx.doctorProfile.update({
        where: { id: profile.id },
        data: { pinFailedCount: 0, pinLockedUntil: new Date(now.getTime() + PIN_LOCK_MS) },
      });
      await writeAudit(tx, request, {
        action: 'doctor.signing_pin_locked',
        organisationId: actor.organisationId,
        actorUserId: actor.userId,
        entityType: 'doctor_profile',
        entityId: profile.id,
      });
      return 'locked' as const;
    });
  }

  private out(row: ProfileRow | null): DoctorProfile {
    const now = this.s.now();
    return {
      registrationNumber: row?.registrationNumber ?? null,
      council: row?.council ?? null,
      qualifications: row?.qualifications ?? null,
      specialty: row?.specialty ?? null,
      rxPrefix: row?.rxPrefix ?? null,
      paperSize: row?.paperSize ?? 'a5',
      verification: row?.verification ?? 'pending',
      verifiedAt: row?.verifiedAt?.toISOString() ?? null,
      pinSet: Boolean(row?.signingPinHash),
      pinLockedUntil:
        row?.pinLockedUntil && row.pinLockedUntil > now ? row.pinLockedUntil.toISOString() : null,
      publicProfile: {
        slug: row?.publicSlug ?? null,
        listed: row?.listed ?? false,
        about: row?.about ?? null,
        languages: row?.languages ?? [],
        live: Boolean(row?.listed && row.publicSlug && row.verification === 'verified'),
      },
    };
  }
}
