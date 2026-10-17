import {
  CreatePlatformOrganisationBody,
  CreatedPlatformOrganisation,
  MfaVerifyBody,
  PlatformDoctorList,
  PlatformDoctorQuery,
  PlatformLoginBody,
  PlatformMeResponse,
  PlatformOrganisationList,
  PlatformUsageQuery,
  PlatformUsageReport,
  RefreshBody,
  VerifiedPlatformDoctor,
  VerifyPlatformDoctorBody,
} from '@dhc/contracts';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../errors';
import type { IpAllowlist } from '../../plugins/ip-allowlist';
import type { Services } from '../../services';
import { PlatformAuthService, authenticatePlatform, platformAuthOf } from './auth';
import { PlatformService } from './service';

export interface PlatformRoutesOptions {
  services: Services;
  signInRateLimit: number;
  /** Networks that may reach any of these routes, sign-in included (PRD §3.3). */
  allowlist: IpAllowlist;
}

const ProfileParams = z.object({ profileId: z.uuid() });

/**
 * The platform console API, mounted at `/v1/platform`. Its own sign-in and token
 * audience; organisations, doctor verification and usage only, never clinical data.
 */
export const platformRoutes: FastifyPluginAsync<PlatformRoutesOptions> = async (
  app,
  { services, signInRateLimit, allowlist },
) => {
  const auth = new PlatformAuthService(services);
  const platform = new PlatformService(services);
  const SIGN_IN_LIMIT = { rateLimit: { max: signInRateLimit, timeWindow: '1 minute' } };
  const operator = { preHandler: authenticatePlatform(services) };

  app.decorateRequest('platformAuth', null);
  // Before anything else, sign-in included: outside the allowed networks the console does
  // not answer at all.
  app.addHook('onRequest', async (request) => {
    if (!allowlist.allows(request.ip)) {
      request.log.warn({ ip: request.ip }, 'Platform console request from a disallowed network');
      throw new AppError(403, 'FORBIDDEN', 'The platform console is not available from here.');
    }
  });

  app.post('/auth/login', { config: SIGN_IN_LIMIT }, async (request) =>
    auth.login(request, PlatformLoginBody.parse(request.body)),
  );

  app.post('/auth/mfa/verify', { config: SIGN_IN_LIMIT }, async (request) => {
    const body = MfaVerifyBody.parse(request.body);
    return auth.verifyMfa(request, body.mfaToken, body.code);
  });

  app.post('/auth/refresh', { config: SIGN_IN_LIMIT }, async (request) =>
    auth.refresh(request, RefreshBody.parse(request.body).refreshToken),
  );

  app.post('/auth/logout', operator, async (request, reply) => {
    await auth.logout(request, platformAuthOf(request));
    return reply.status(204).send();
  });

  app.get('/me', operator, async (request) =>
    PlatformMeResponse.parse(await platform.me(platformAuthOf(request))),
  );

  app.get('/organisations', operator, async (request) =>
    PlatformOrganisationList.parse({
      data: await platform.listOrganisations(request, platformAuthOf(request)),
    }),
  );

  app.post('/organisations', operator, async (request, reply) => {
    const body = CreatePlatformOrganisationBody.parse(request.body);
    const created = await platform.createOrganisation(request, platformAuthOf(request), body);
    return reply.status(201).send(CreatedPlatformOrganisation.parse(created));
  });

  app.get('/doctors', operator, async (request) => {
    const { status, cursor } = PlatformDoctorQuery.parse(request.query);
    return PlatformDoctorList.parse(
      await platform.listDoctors(request, platformAuthOf(request), status, cursor),
    );
  });

  app.post('/doctors/:profileId/verify', operator, async (request) => {
    const { profileId } = ProfileParams.parse(request.params);
    const body = VerifyPlatformDoctorBody.parse(request.body);
    return VerifiedPlatformDoctor.parse(
      await platform.verifyDoctor(request, platformAuthOf(request), profileId, body),
    );
  });

  app.get('/usage', operator, async (request) =>
    PlatformUsageReport.parse(
      await platform.usage(
        request,
        platformAuthOf(request),
        PlatformUsageQuery.parse(request.query),
      ),
    ),
  );
};
