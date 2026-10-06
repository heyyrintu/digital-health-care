import { withAuth } from '@dhc/db';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AccessClaims, Role } from '../auth/tokens';
import { AppError } from '../errors';
import type { Services } from '../services';

declare module 'fastify' {
  interface FastifyRequest {
    auth: AccessClaims | null;
  }
}

/**
 * Verifies the bearer token and that its session is still live, so a revoked device or
 * logout stops working on the next request rather than when the token expires.
 */
export function authenticate(services: Services) {
  return async (request: FastifyRequest) => {
    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    const claims = token ? await services.tokens.verifyAccessToken(token) : null;
    if (!claims) throw new AppError(401, 'UNAUTHENTICATED', 'Please sign in again.');

    const session = await withAuth(services.db, (tx) =>
      tx.session.findUnique({
        where: { id: claims.sessionId },
        select: { userId: true, revokedAt: true, expiresAt: true },
      }),
    );
    if (
      !session ||
      session.userId !== claims.userId ||
      session.revokedAt ||
      session.expiresAt <= services.now()
    ) {
      throw new AppError(401, 'UNAUTHENTICATED', 'Please sign in again.');
    }
    request.auth = claims;
  };
}

export function requireRole(...roles: Role[]) {
  return async (request: FastifyRequest, _reply: FastifyReply) => {
    if (!request.auth || !roles.includes(request.auth.role)) {
      throw new AppError(403, 'FORBIDDEN', 'You do not have access to this.');
    }
  };
}

/** For handlers behind `authenticate`: the claims, guaranteed present. */
export function authOf(request: FastifyRequest): AccessClaims {
  if (!request.auth) throw new AppError(401, 'UNAUTHENTICATED', 'Please sign in again.');
  return request.auth;
}
