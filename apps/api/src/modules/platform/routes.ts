import {
  MedicineReviewBundle,
  MedicineStageDetail,
  MedicineStageList,
  MedicineStageQuery,
  MedicineStageReviewBody,
  MedicineStagePublishBody,
  MedicineSandboxView,
} from '@dhc/contracts';
import { MedicineReviewService } from '../medicine-review/service';
import { registerAccountSecurity } from '../account-security/routes';
import {
  CreatePlatformOrganisationBody,
  CreatedPlatformOrganisation,
  MfaVerifyBody,
  PlatformDoctorList,
  PlatformDoctorQuery,
  PlatformHealth,
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
  /** This server's version (APP_VERSION), for system health. */
  version: string;
}

const ProfileParams = z.object({ profileId: z.uuid() });

/**
 * The platform console API, mounted at `/v1/platform`. Its own sign-in and token
 * audience; organisations, doctor verification, usage and system health only, never
 * clinical data.
 */
export const platformRoutes: FastifyPluginAsync<PlatformRoutesOptions> = async (
  app,
  { services, signInRateLimit, allowlist, version },
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

  await registerAccountSecurity(
    app,
    services,
    'platform',
    signInRateLimit,
    authenticatePlatform(services),
    (request) => {
      const a = platformAuthOf(request);
      return { id: a.operatorId, sessionId: a.sessionId };
    },
  );

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

  const medicines = new MedicineReviewService(services);
  const stageParams = z.object({ id: z.uuid() });
  app.get('/medicine-stages', operator, async (request) => {
    const query = MedicineStageQuery.parse(request.query);
    return MedicineStageList.parse(
      await medicines.list(request, platformAuthOf(request).operatorId, query.cursor, query.state),
    );
  });
  app.post(
    '/medicine-stages',
    {
      ...operator,
      bodyLimit: 2 * 1024 * 1024,
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const result = await medicines.create(
        request,
        platformAuthOf(request).operatorId,
        MedicineReviewBundle.parse(request.body),
      );
      return reply.code(result.created ? 201 : 200).send(MedicineStageDetail.parse(result.stage));
    },
  );
  app.get('/medicine-stages/:id', operator, async (request) =>
    MedicineStageDetail.parse(
      await medicines.read(
        request,
        platformAuthOf(request).operatorId,
        stageParams.parse(request.params).id,
      ),
    ),
  );
  app.post('/medicine-stages/:id/review', operator, async (request) =>
    MedicineStageDetail.parse(
      await medicines.review(
        request,
        platformAuthOf(request).operatorId,
        stageParams.parse(request.params).id,
        MedicineStageReviewBody.parse(request.body),
      ),
    ),
  );
  app.get('/medicine-sandbox', operator, async (request) =>
    MedicineSandboxView.parse(await medicines.sandbox(request, platformAuthOf(request).operatorId)),
  );
  app.post('/medicine-stages/:id/publish-sandbox', operator, async (request) =>
    MedicineSandboxView.parse(
      await medicines.publish(
        request,
        platformAuthOf(request).operatorId,
        stageParams.parse(request.params).id,
        MedicineStagePublishBody.parse(request.body),
      ),
    ),
  );

  app.get('/health', operator, async (request) =>
    PlatformHealth.parse(await platform.health(request, platformAuthOf(request), version)),
  );
};
