import type { LoginBody, LoginResponse, OtpRequestResponse, TokenResponse } from '@dhc/contracts';
import { STAFF_ROLES } from '@dhc/contracts';
import { withAuth, type Tx } from '@dhc/db';
import type { FastifyRequest } from 'fastify';
import { randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { DUMMY_PASSWORD_HASH, verifyPassword } from '../../auth/password';
import { normaliseIndianMobile } from '../../auth/phone';
import { ACCESS_TOKEN_TTL_SECONDS, hashToken, newRefreshToken, type Role } from '../../auth/tokens';
import { matchTotpStep } from '../../auth/totp';
import { AppError } from '../../errors';
import type { Services } from '../../services';
import { writeAudit } from '../audit/write';

const OTP_TTL_MS = 5 * 60_000;
const OTP_MAX_ATTEMPTS = 5;
const OTP_MAX_PER_WINDOW = 3;
const OTP_WINDOW_MS = 10 * 60_000;
const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MS = 15 * 60_000;
const PATIENT_SESSION_MS = 30 * 24 * 3600_000;
export const STAFF_SESSION_MS = 12 * 3600_000;
export const TOTP_ISSUER = 'DHC Clinic';

const INVALID_LOGIN = () => new AppError(401, 'UNAUTHENTICATED', 'Invalid sign-in details.');
export const INVALID_CODE = () =>
  new AppError(401, 'UNAUTHENTICATED', 'The code is invalid or has expired.');
export const LOCKED = () =>
  new AppError(429, 'RATE_LIMITED', 'Too many attempts. Try again in 15 minutes.');
const SETUP_INCOMPLETE = () =>
  new AppError(401, 'UNAUTHENTICATED', 'Finish setting up your account using your invite link.');

export class AuthService {
  constructor(private readonly s: Services) {}

  // ---- Patients: mobile OTP -------------------------------------------------------

  async requestOtp(
    request: FastifyRequest,
    organisationSlug: string,
    rawPhone: string,
  ): Promise<OtpRequestResponse> {
    const phone = normaliseIndianMobile(rawPhone);
    if (!phone) {
      throw new AppError(400, 'VALIDATION_FAILED', 'Enter a valid Indian mobile number.', {
        phone: 'invalid',
      });
    }
    const now = this.s.now();
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');

    const challenge = await withAuth(this.s.db, async (tx) => {
      const org = await activeOrganisation(tx, organisationSlug);
      if (!org) throw new AppError(404, 'NOT_FOUND', 'Clinic not found.');

      const recent = await tx.otpChallenge.count({
        where: { phone, createdAt: { gt: new Date(now.getTime() - OTP_WINDOW_MS) } },
      });
      if (recent >= OTP_MAX_PER_WINDOW) {
        throw new AppError(
          429,
          'RATE_LIMITED',
          'Too many codes requested. Try again in a few minutes.',
        );
      }

      const id = randomUUID();
      const created = await tx.otpChallenge.create({
        data: {
          id,
          phone,
          organisationId: org.id,
          codeHash: this.s.hashOtp(id, code),
          createdAt: now,
          expiresAt: new Date(now.getTime() + OTP_TTL_MS),
        },
      });
      await writeAudit(tx, request, {
        action: 'auth.otp.requested',
        organisationId: org.id,
        entityType: 'otp_challenge',
        entityId: id,
      });
      return created;
    });

    await this.s.otpSender.send(phone, code);
    return { challengeId: challenge.id, expiresAt: challenge.expiresAt.toISOString() };
  }

  async verifyOtp(
    request: FastifyRequest,
    challengeId: string,
    code: string,
  ): Promise<TokenResponse> {
    const now = this.s.now();
    const result = await withAuth(this.s.db, async (tx) => {
      const challenge = await tx.otpChallenge.findUnique({ where: { id: challengeId } });
      if (
        !challenge ||
        challenge.consumedAt ||
        challenge.expiresAt <= now ||
        challenge.attempts >= OTP_MAX_ATTEMPTS
      ) {
        return { ok: false as const };
      }
      if (!safeEqual(this.s.hashOtp(challenge.id, code), challenge.codeHash)) {
        await tx.otpChallenge.update({
          where: { id: challenge.id },
          data: { attempts: { increment: 1 } },
        });
        await writeAudit(tx, request, {
          action: 'auth.otp.failed',
          organisationId: challenge.organisationId,
          entityType: 'otp_challenge',
          entityId: challenge.id,
        });
        return { ok: false as const };
      }
      // Conditional update: two concurrent verifies cannot both consume the code.
      const consumed = await tx.otpChallenge.updateMany({
        where: { id: challenge.id, consumedAt: null },
        data: { consumedAt: now },
      });
      if (consumed.count !== 1) return { ok: false as const };

      const org = await tx.organisation.findUnique({ where: { id: challenge.organisationId } });
      if (!org || org.status !== 'active') return { ok: false as const };

      const user =
        (await tx.user.findUnique({ where: { phone: challenge.phone } })) ??
        (await tx.user.create({ data: { phone: challenge.phone } }));
      if (user.status !== 'active') return { ok: false as const };

      const membership = await tx.membership.findUnique({
        where: {
          organisationId_userId_role: { organisationId: org.id, userId: user.id, role: 'patient' },
        },
      });
      if (membership?.status === 'revoked') return { ok: false as const };
      if (!membership) {
        await tx.membership.create({
          data: { organisationId: org.id, userId: user.id, role: 'patient' },
        });
      }

      await tx.user.update({ where: { id: user.id }, data: { lastLoginAt: now } });
      const tokens = await this.startSession(
        tx,
        request,
        user.id,
        org.id,
        'patient',
        PATIENT_SESSION_MS,
      );
      await writeAudit(tx, request, {
        action: 'auth.otp.verified',
        organisationId: org.id,
        actorUserId: user.id,
      });
      return { ok: true as const, tokens };
    });
    // Failed attempts are committed above; only then report the failure.
    if (!result.ok) throw INVALID_CODE();
    return result.tokens;
  }

  // ---- Staff: password, then authenticator code -----------------------------------

  async login(request: FastifyRequest, body: LoginBody): Promise<LoginResponse> {
    const now = this.s.now();
    const outcome = await withAuth(this.s.db, async (tx) => {
      const org = await activeOrganisation(tx, body.organisation);
      const identifier = body.identifier.trim();
      const user = identifier.includes('@')
        ? await tx.user.findUnique({ where: { email: identifier.toLowerCase() } })
        : await findByPhone(tx, identifier);

      if (!org || !user?.passwordHash) {
        await verifyPassword(body.password, DUMMY_PASSWORD_HASH); // equal timing for unknown users
        await writeAudit(tx, request, {
          action: 'auth.login.failed',
          organisationId: org?.id,
          metadata: { reason: 'unknown' },
        });
        return { error: INVALID_LOGIN() };
      }
      if (user.lockedUntil && user.lockedUntil > now) {
        await writeAudit(tx, request, {
          action: 'auth.login.locked',
          organisationId: org.id,
          actorUserId: user.id,
        });
        return { error: LOCKED() };
      }
      if (!(await verifyPassword(body.password, user.passwordHash))) {
        await recordFailure(tx, user.id, user.failedLoginCount, now);
        await writeAudit(tx, request, {
          action: 'auth.login.failed',
          organisationId: org.id,
          actorUserId: user.id,
          metadata: { reason: 'password' },
        });
        return { error: INVALID_LOGIN() };
      }
      await tx.user.update({
        where: { id: user.id },
        data: { failedLoginCount: 0, lockedUntil: null },
      });

      const roles = (
        await tx.membership.findMany({
          where: {
            organisationId: org.id,
            userId: user.id,
            status: 'active',
            role: { in: [...STAFF_ROLES] },
          },
          select: { role: true },
        })
      ).map((m) => m.role as Role);
      const role = body.role
        ? roles.find((r) => r === body.role)
        : roles.length === 1
          ? roles[0]
          : undefined;
      if (user.status !== 'active' || roles.length === 0 || (body.role && !role)) {
        await writeAudit(tx, request, {
          action: 'auth.login.failed',
          organisationId: org.id,
          actorUserId: user.id,
          metadata: { reason: 'no_access' },
        });
        return { error: INVALID_LOGIN() };
      }
      if (!role) {
        return {
          error: new AppError(400, 'VALIDATION_FAILED', 'Choose which role to sign in as.', {
            role: roles.join(','),
          }),
        };
      }

      // Authenticators are only ever enrolled through an admin-issued invite, so a password
      // alone can never attach a new authenticator to an account.
      if (!user.mfaSecret) {
        await writeAudit(tx, request, {
          action: 'auth.login.failed',
          organisationId: org.id,
          actorUserId: user.id,
          metadata: { reason: 'setup_incomplete' },
        });
        return { error: SETUP_INCOMPLETE() };
      }
      const mfaToken = await this.s.tokens.createMfaToken(user.id, org.id, role);
      return { response: { status: 'mfa_required' as const, mfaToken } };
    });
    if ('error' in outcome) throw outcome.error;
    return outcome.response;
  }

  async verifyMfa(request: FastifyRequest, mfaToken: string, code: string): Promise<TokenResponse> {
    const claims = await this.s.tokens.verifyMfaToken(mfaToken);
    if (!claims)
      throw new AppError(401, 'UNAUTHENTICATED', 'Your sign-in has expired. Start again.');
    const now = this.s.now();

    const outcome = await withAuth(this.s.db, async (tx) => {
      const user = await tx.user.findUnique({ where: { id: claims.userId } });
      if (!user || user.status !== 'active') return { error: INVALID_LOGIN() };
      if (user.lockedUntil && user.lockedUntil > now) return { error: LOCKED() };

      if (!user.mfaSecret) return { error: SETUP_INCOMPLETE() };

      const step = matchTotpStep(this.s.cipher.decrypt(user.mfaSecret), code, now.getTime());
      if (step === null || (user.mfaLastUsedStep !== null && step <= user.mfaLastUsedStep)) {
        await recordFailure(tx, user.id, user.failedLoginCount, now);
        await writeAudit(tx, request, {
          action: 'auth.mfa.failed',
          organisationId: claims.organisationId,
          actorUserId: user.id,
        });
        return { error: INVALID_CODE() };
      }

      const membership = await tx.membership.findFirst({
        where: {
          organisationId: claims.organisationId,
          userId: user.id,
          role: claims.role,
          status: 'active',
        },
      });
      if (!membership) return { error: INVALID_LOGIN() };

      await tx.user.update({
        where: { id: user.id },
        data: {
          mfaLastUsedStep: step,
          failedLoginCount: 0,
          lastLoginAt: now,
        },
      });
      const tokens = await this.startSession(
        tx,
        request,
        user.id,
        claims.organisationId,
        claims.role,
        STAFF_SESSION_MS,
      );
      await writeAudit(tx, request, {
        action: 'auth.login.succeeded',
        organisationId: claims.organisationId,
        actorUserId: user.id,
      });
      return { tokens };
    });
    if ('error' in outcome) throw outcome.error;
    return outcome.tokens;
  }

  // ---- Sessions ---------------------------------------------------------------------

  async refresh(request: FastifyRequest, refreshToken: string): Promise<TokenResponse> {
    const now = this.s.now();
    const oldHash = hashToken(refreshToken);

    const outcome = await withAuth(this.s.db, async (tx) => {
      const session = await tx.session.findUnique({ where: { refreshTokenHash: oldHash } });
      if (!session) {
        // A rotated-out token being replayed means it was copied: end that session.
        const reused = await tx.session.findUnique({
          where: { previousRefreshTokenHash: oldHash },
        });
        if (reused && !reused.revokedAt) {
          await tx.session.update({
            where: { id: reused.id },
            data: { revokedAt: now, revokedReason: 'refresh_token_reuse' },
          });
          await writeAudit(tx, request, {
            action: 'auth.refresh.reuse_detected',
            organisationId: reused.organisationId,
            actorUserId: reused.userId,
            entityType: 'session',
            entityId: reused.id,
          });
        }
        return null;
      }
      if (session.revokedAt || session.expiresAt <= now) return null;

      const membership = await tx.membership.findFirst({
        where: {
          organisationId: session.organisationId,
          userId: session.userId,
          role: session.role,
          status: 'active',
        },
        select: { id: true },
      });
      const user = await tx.user.findUnique({
        where: { id: session.userId },
        select: { status: true },
      });
      if (!membership || user?.status !== 'active') {
        await tx.session.update({
          where: { id: session.id },
          data: { revokedAt: now, revokedReason: 'access_removed' },
        });
        return null;
      }

      const next = newRefreshToken();
      const rotated = await tx.session.updateMany({
        where: { id: session.id, refreshTokenHash: oldHash },
        data: {
          refreshTokenHash: hashToken(next),
          previousRefreshTokenHash: oldHash,
          lastUsedAt: now,
        },
      });
      if (rotated.count !== 1) return null;
      return {
        tokenType: 'Bearer' as const,
        accessToken: await this.s.tokens.createAccessToken({
          userId: session.userId,
          organisationId: session.organisationId,
          role: session.role as Role,
          sessionId: session.id,
        }),
        expiresIn: ACCESS_TOKEN_TTL_SECONDS,
        refreshToken: next,
      };
    });
    if (!outcome) throw new AppError(401, 'UNAUTHENTICATED', 'Please sign in again.');
    return outcome;
  }

  async logout(
    request: FastifyRequest,
    sessionId: string,
    userId: string,
    organisationId: string,
  ): Promise<void> {
    await withAuth(this.s.db, async (tx) => {
      await tx.session.updateMany({
        where: { id: sessionId, revokedAt: null },
        data: { revokedAt: this.s.now(), revokedReason: 'logout' },
      });
      await writeAudit(tx, request, {
        action: 'auth.logout',
        organisationId,
        actorUserId: userId,
        entityType: 'session',
        entityId: sessionId,
      });
    });
  }

  /** Creates a session and its first token pair. Callers write their own audit event. */
  async startSession(
    tx: Tx,
    request: FastifyRequest,
    userId: string,
    organisationId: string,
    role: Role,
    lifetimeMs: number,
  ): Promise<TokenResponse> {
    const refreshToken = newRefreshToken();
    const session = await tx.session.create({
      data: {
        userId,
        organisationId,
        role,
        refreshTokenHash: hashToken(refreshToken),
        userAgent: request.headers['user-agent']?.slice(0, 300) ?? null,
        ip: request.ip,
        expiresAt: new Date(this.s.now().getTime() + lifetimeMs),
      },
    });
    await writeAudit(tx, request, {
      action: 'auth.session.created',
      organisationId,
      actorUserId: userId,
      entityType: 'session',
      entityId: session.id,
    });
    return {
      tokenType: 'Bearer',
      accessToken: await this.s.tokens.createAccessToken({
        userId,
        organisationId,
        role,
        sessionId: session.id,
      }),
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
      refreshToken,
    };
  }
}

export async function activeOrganisation(tx: Tx, slug: string) {
  const org = await tx.organisation.findUnique({ where: { slug } });
  return org?.status === 'active' ? org : null;
}

export async function findByPhone(tx: Tx, raw: string) {
  const phone = normaliseIndianMobile(raw);
  return phone ? tx.user.findUnique({ where: { phone } }) : null;
}

export async function recordFailure(tx: Tx, userId: string, previousFailures: number, now: Date) {
  const failures = previousFailures + 1;
  await tx.user.update({
    where: { id: userId },
    data:
      failures >= MAX_FAILED_LOGINS
        ? { failedLoginCount: 0, lockedUntil: new Date(now.getTime() + LOCKOUT_MS) }
        : { failedLoginCount: failures },
  });
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
