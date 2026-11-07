import {
  STAFF_ROLES,
  ReviewSettings,
  ReviewSettingsBody,
  ReviewConsent,
  ReviewConsentBody,
  ReviewRequest,
  ReviewRequestList,
  RequestReview,
  ReviewQuery,
  ResolveReviewBody,
  ReviewLanding,
  ReviewDestination,
} from '@dhc/contracts';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Services } from '../../services';
import { authenticate, authOf, requireRole } from '../../plugins/authenticate';
import { ReviewsService } from './service';
export const reviewRoutes: FastifyPluginAsync<{ services: Services }> = async (
  app,
  { services },
) => {
  const reviews = new ReviewsService(services),
    auth = authenticate(services);
  const staff = { preHandler: [auth, requireRole(...STAFF_ROLES)] },
    admin = { preHandler: [auth, requireRole('clinic_admin')] },
    patient = { preHandler: [auth, requireRole('patient')] };
  const limit = { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    ids = z.object({ id: z.uuid() });
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
    return payload;
  });
  app.get('/review-settings', admin, async (r) =>
    ReviewSettings.parse(await reviews.settings(authOf(r))),
  );
  app.put('/review-settings', { ...admin, ...limit }, async (r) =>
    ReviewSettings.parse(
      await reviews.saveSettings(r, authOf(r), ReviewSettingsBody.parse(r.body)),
    ),
  );
  app.get('/portal/review-consent', patient, async (r) =>
    ReviewConsent.parse(await reviews.consent(r, authOf(r))),
  );
  app.put('/portal/review-consent', { ...patient, ...limit }, async (r) =>
    ReviewConsent.parse(await reviews.consent(r, authOf(r), ReviewConsentBody.parse(r.body))),
  );
  app.get('/review-requests', staff, async (r) =>
    ReviewRequestList.parse(await reviews.list(authOf(r), ReviewQuery.parse(r.query).cursor)),
  );
  app.post('/review-requests', { ...staff, ...limit }, async (r, reply) =>
    reply
      .code(201)
      .send(ReviewRequest.parse(await reviews.request(r, authOf(r), RequestReview.parse(r.body)))),
  );
  app.post('/review-requests/:id/cancel', { ...staff, ...limit }, async (r) =>
    ReviewRequest.parse(await reviews.cancel(r, authOf(r), ids.parse(r.params).id)),
  );
  app.post('/review-links/resolve', limit, async (r) =>
    ReviewLanding.parse(await reviews.resolve(ResolveReviewBody.parse(r.body).token)),
  );
  app.post('/review-links/open', limit, async (r) =>
    ReviewDestination.parse(await reviews.resolve(ResolveReviewBody.parse(r.body).token, true)),
  );
};
