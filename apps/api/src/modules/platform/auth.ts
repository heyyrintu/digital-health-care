import type { PlatformLoginBody, PlatformLoginResponse, TokenResponse } from '@dhc/contracts';
import { withPlatform, type Tx } from '@dhc/db';
import type { FastifyRequest } from 'fastify';
import { DUMMY_PASSWORD_HASH, verifyPassword } from '../../auth/password';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  hashToken,
  newRefreshToken,
  type PlatformAccessClaims,
} from '../../auth/tokens';
import { matchTotpStep } from '../../auth/totp';
import { AppError } from '../../errors';
import type { Services } from '../../services';
import { writeAudit, type AuditSource } from '../audit/write';
import {
  INVALID_CODE,
  INVALID_LOGIN,
  LOCKED,
  LOCKOUT_MS,
  MAX_FAILED_LOGINS,
} from '../auth/service';

/** Platform console sessions are a working day; refresh tokens rotate as for staff. */
export const PLATFORM_SESSION_MS = 8 * 3600_000;

const SIGN_IN_AGAIN = () => new AppError(401, 'UNAUTHENTICATED', 'Please sign in again.');

declare module 'fastify' {
  interface FastifyRequest {
    platformAuth: PlatformAccessClaims | null;
  }
}

/** A platform-level audit entry: it belongs to no organisation. */
async function auditOperator(
  tx: Tx,
  source: AuditSource,
  action: string,
  operatorId: string | null,
  metadata?: Record<string, string | number>,
) {
  await writeAudit(tx, source, {
    action,
    organisationId: null,
    actorUserId: null,
    ...(operatorId ? { entityType: 'platform_operator', entityId: operatorId } : {}),
    metadata,
  });
}

/**
 * Counts a failed password or code for an operator. Atomic, as for staff
 * (`recordFailure`): concurrent wrong guesses cannot all stay under the limit.
 */
async function recordOperatorFailure(tx: Tx, operatorId: string, now: Date) {
  const { failedLoginCount } = await tx.platformOperator.update({
    where: { id: operatorId },
    data: { failedLoginCount: { increment: 1 } },
    select: { failedLoginCount: true },
  });
  if (failedLoginCount >= MAX_FAILED_LOGINS) {
    await tx.platformOperator.update({
      where: { id: operatorId },
      data: { failedLoginCount: 0, lockedUntil: new Date(now.getTime() + LOCKOUT_MS) },
    });
  }
}

/**
 * Platform operators' sign-in: password, then authenticator code (PRD §3.3). Mirrors staff
 * sign-in (lockout after 5 wrong passwords or codes, single-use codes, rotating refresh
 * tokens with reuse detection) but against platform operators only, as `dhc_platform`,
 * with tokens of the platform audience.
 */
export class PlatformAuthService {
  constructor(private readonly s: Services) {}

  async login(request: FastifyRequest, body: PlatformLoginBody): Promise<PlatformLoginResponse> {
    const now = this.s.now();
    const email = body.email.trim().toLowerCase();
    const found = await withPlatform(this.s.db, (tx) =>
      tx.platformOperator.findUnique({
        where: { email },
        select: { id: true, passwordHash: true },
      }),
    );
    // scrypt runs between transactions (slow by design; see AuthService.login). Unknown
    // emails get a dummy check so the timing is the same.
    const checkedHash = found?.passwordHash;
    const passwordOk = await verifyPassword(body.password, checkedHash ?? DUMMY_PASSWORD_HASH);

    const outcome = await withPlatform(this.s.db, async (tx) => {
      // Re-read: lockout, failure count and password may have changed meanwhile.
      const operator = found
        ? await tx.platformOperator.findUnique({ where: { id: found.id } })
        : null;
      if (!operator) {
        await auditOperator(tx, request, 'platform.auth.login.failed', null, {
          reason: 'unknown',
        });
        return { error: INVALID_LOGIN() };
      }
      if (operator.lockedUntil && operator.lockedUntil > now) {
        await auditOperator(tx, request, 'platform.auth.login.locked', operator.id);
        return { error: LOCKED() };
      }
      if (!passwordOk || operator.passwordHash !== checkedHash) {
        await recordOperatorFailure(tx, operator.id, now);
        await auditOperator(tx, request, 'platform.auth.login.failed', operator.id, {
          reason: 'password',
        });
        return { error: INVALID_LOGIN() };
      }
      if (operator.status !== 'active') {
        await auditOperator(tx, request, 'platform.auth.login.failed', operator.id, {
          reason: 'disabled',
        });
        return { error: INVALID_LOGIN() };
      }
      // The failure count is not reset here: only a correct authenticator code resets it,
      // so someone who knows the password cannot keep guessing codes across sign-ins.
      const mfaToken = await this.s.platformTokens.createMfaToken(operator.id);
      return { response: { status: 'mfa_required' as const, mfaToken } };
    });
    if ('error' in outcome) throw outcome.error;
    return outcome.response;
  }

  async verifyMfa(request: FastifyRequest, mfaToken: string, code: string): Promise<TokenResponse> {
    const claims = await this.s.platformTokens.verifyMfaToken(mfaToken);
    if (!claims) {
      throw new AppError(401, 'UNAUTHENTICATED', 'Your sign-in has expired. Start again.');
    }
    const now = this.s.now();

    const outcome = await withPlatform(this.s.db, async (tx) => {
      const operator = await tx.platformOperator.findUnique({ where: { id: claims.operatorId } });
      if (!operator || operator.status !== 'active') return { error: INVALID_LOGIN() };
      if (operator.lockedUntil && operator.lockedUntil > now) {
        await auditOperator(tx, request, 'platform.auth.login.locked', operator.id, {
          step: 'mfa',
        });
        return { error: LOCKED() };
      }

      const step = matchTotpStep(this.s.cipher.decrypt(operator.mfaSecret), code, now.getTime());
      if (
        step === null ||
        (operator.mfaLastUsedStep !== null && step <= operator.mfaLastUsedStep)
      ) {
        await recordOperatorFailure(tx, operator.id, now);
        await auditOperator(tx, request, 'platform.auth.mfa.failed', operator.id);
        return { error: INVALID_CODE() };
      }
      // Conditional: of two requests racing with the same code, only one moves the step on.
      const accepted = await tx.platformOperator.updateMany({
        where: {
          id: operator.id,
          OR: [{ mfaLastUsedStep: null }, { mfaLastUsedStep: { lt: step } }],
        },
        data: { mfaLastUsedStep: step, failedLoginCount: 0, lockedUntil: null, lastLoginAt: now },
      });
      if (accepted.count !== 1) {
        await recordOperatorFailure(tx, operator.id, now);
        await auditOperator(tx, request, 'platform.auth.mfa.failed', operator.id, {
          reason: 'code_reused',
        });
        return { error: INVALID_CODE() };
      }

      const refreshToken = newRefreshToken();
      const session = await tx.platformSession.create({
        data: {
          operatorId: operator.id,
          refreshTokenHash: hashToken(refreshToken),
          userAgent: request.headers['user-agent']?.slice(0, 300) ?? null,
          ip: request.ip,
          expiresAt: new Date(now.getTime() + PLATFORM_SESSION_MS),
          lastUsedAt: now,
          createdAt: now,
        },
      });
      await auditOperator(tx, request, 'platform.auth.login.succeeded', operator.id, {
        sessionId: session.id,
      });
      return {
        tokens: {
          tokenType: 'Bearer' as const,
          accessToken: await this.s.platformTokens.createAccessToken({
            operatorId: operator.id,
            sessionId: session.id,
          }),
          expiresIn: ACCESS_TOKEN_TTL_SECONDS,
          refreshToken,
        },
      };
    });
    if ('error' in outcome) throw outcome.error;
    return outcome.tokens;
  }

  async refresh(request: FastifyRequest, refreshToken: string): Promise<TokenResponse> {
    const now = this.s.now();
    const oldHash = hashToken(refreshToken);

    const outcome = await withPlatform(this.s.db, async (tx) => {
      const session = await tx.platformSession.findUnique({ where: { refreshTokenHash: oldHash } });
      if (!session) {
        // A rotated-out token being replayed means it was copied: end that session.
        const reused = await tx.platformSession.findUnique({
          where: { previousRefreshTokenHash: oldHash },
        });
        if (reused && !reused.revokedAt) {
          await tx.platformSession.update({
            where: { id: reused.id },
            data: { revokedAt: now, revokedReason: 'refresh_token_reuse' },
          });
          await auditOperator(
            tx,
            request,
            'platform.auth.refresh.reuse_detected',
            reused.operatorId,
            {
              sessionId: reused.id,
            },
          );
        }
        return null;
      }
      if (session.revokedAt || session.expiresAt <= now) return null;
      const operator = await tx.platformOperator.findUnique({
        where: { id: session.operatorId },
        select: { status: true },
      });
      if (operator?.status !== 'active') {
        await tx.platformSession.update({
          where: { id: session.id },
          data: { revokedAt: now, revokedReason: 'access_removed' },
        });
        return null;
      }
      const next = newRefreshToken();
      const rotated = await tx.platformSession.updateMany({
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
        accessToken: await this.s.platformTokens.createAccessToken({
          operatorId: session.operatorId,
          sessionId: session.id,
        }),
        expiresIn: ACCESS_TOKEN_TTL_SECONDS,
        refreshToken: next,
      };
    });
    if (!outcome) throw SIGN_IN_AGAIN();
    return outcome;
  }

  async logout(request: FastifyRequest, claims: PlatformAccessClaims): Promise<void> {
    await withPlatform(this.s.db, async (tx) => {
      await tx.platformSession.updateMany({
        where: { id: claims.sessionId, revokedAt: null },
        data: { revokedAt: this.s.now(), revokedReason: 'logout' },
      });
      await auditOperator(tx, request, 'platform.auth.logout', claims.operatorId, {
        sessionId: claims.sessionId,
      });
    });
  }
}

/**
 * Verifies a platform bearer token and that its session and operator are still live.
 * Clinic tokens never pass (another audience and key), so `/platform/*` is closed to
 * clinic staff, and these tokens open nothing outside it.
 */
export function authenticatePlatform(services: Services) {
  return async (request: FastifyRequest) => {
    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    const claims = token ? await services.platformTokens.verifyAccessToken(token) : null;
    if (!claims) throw SIGN_IN_AGAIN();
    const live = await withPlatform(services.db, async (tx) => {
      const session = await tx.platformSession.findUnique({
        where: { id: claims.sessionId },
        select: { operatorId: true, revokedAt: true, expiresAt: true },
      });
      if (
        !session ||
        session.operatorId !== claims.operatorId ||
        session.revokedAt ||
        session.expiresAt <= services.now()
      ) {
        return false;
      }
      const operator = await tx.platformOperator.findUnique({
        where: { id: claims.operatorId },
        select: { status: true },
      });
      return operator?.status === 'active';
    });
    if (!live) throw SIGN_IN_AGAIN();
    request.platformAuth = claims;
  };
}

/** For handlers behind `authenticatePlatform`: the claims, guaranteed present. */
export function platformAuthOf(request: FastifyRequest): PlatformAccessClaims {
  if (!request.platformAuth) throw SIGN_IN_AGAIN();
  return request.platformAuth;
}
