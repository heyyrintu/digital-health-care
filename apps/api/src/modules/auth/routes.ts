import {
  LoginBody,
  MeResponse,
  MfaVerifyBody,
  OtpRequestBody,
  OtpVerifyBody,
  RefreshBody,
} from '@dhc/contracts';
import { withAuth } from '@dhc/db';
import type { FastifyPluginAsync } from 'fastify';
import { AppError } from '../../errors';
import { authOf, authenticate } from '../../plugins/authenticate';
import type { Services } from '../../services';
import { AuthService } from './service';

export interface AuthRoutesOptions {
  services: Services;
  /** Sign-in requests per IP per minute; tighter than the rest of the API. */
  signInRateLimit: number;
}

export const authRoutes: FastifyPluginAsync<AuthRoutesOptions> = async (
  app,
  { services, signInRateLimit },
) => {
  const auth = new AuthService(services);
  const SIGN_IN_LIMIT = { rateLimit: { max: signInRateLimit, timeWindow: '1 minute' } };

  app.post('/auth/otp/request', { config: SIGN_IN_LIMIT }, async (request) => {
    const body = OtpRequestBody.parse(request.body);
    return auth.requestOtp(request, body.organisation, body.phone);
  });

  app.post('/auth/otp/verify', { config: SIGN_IN_LIMIT }, async (request) => {
    const body = OtpVerifyBody.parse(request.body);
    return auth.verifyOtp(request, body.challengeId, body.code);
  });

  app.post('/auth/login', { config: SIGN_IN_LIMIT }, async (request) =>
    auth.login(request, LoginBody.parse(request.body)),
  );

  app.post('/auth/mfa/verify', { config: SIGN_IN_LIMIT }, async (request) => {
    const body = MfaVerifyBody.parse(request.body);
    return auth.verifyMfa(request, body.mfaToken, body.code);
  });

  app.post('/auth/refresh', { config: SIGN_IN_LIMIT }, async (request) =>
    auth.refresh(request, RefreshBody.parse(request.body).refreshToken),
  );

  app.post('/auth/logout', { preHandler: authenticate(services) }, async (request, reply) => {
    const { sessionId, userId, organisationId } = authOf(request);
    await auth.logout(request, sessionId, userId, organisationId);
    return reply.status(204).send();
  });

  app.get('/me', { preHandler: authenticate(services) }, async (request) => {
    const { userId, organisationId, role } = authOf(request);
    // One after another: a transaction is one connection, which runs one query at a time.
    const { user, organisation } = await withAuth(services.db, async (tx) => ({
      user: await tx.user.findUnique({
        where: { id: userId },
        select: { id: true, displayName: true, phone: true, email: true },
      }),
      organisation: await tx.organisation.findUnique({
        where: { id: organisationId },
        select: { id: true, slug: true, name: true },
      }),
    }));
    if (!user || !organisation) throw new AppError(401, 'UNAUTHENTICATED', 'Please sign in again.');
    return MeResponse.parse({ user, organisation, role });
  });
};
