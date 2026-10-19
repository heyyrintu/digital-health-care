import {
  CloseReferralBody,
  CreateReferralBody,
  Referral,
  ReferralCounts,
  ReferralList,
  ReferralListQuery,
  VisitReferralList,
} from '@dhc/contracts';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { idempotent } from '../../idempotency';
import { authOf, authenticate, requireRole } from '../../plugins/authenticate';
import type { Services } from '../../services';
import { ReferralService } from './service';

const IdParams = z.object({ id: z.uuid() });

/**
 * Referrals (PRD §7.2): made from a visit by its doctor, listed for the doctors who sent
 * and received them, marked seen by the receiving doctor and closed by either. Doctors
 * only: the front desk and clinic admins have no clinical access (PRD §3.2).
 */
export const referralRoutes: FastifyPluginAsync<{ services: Services }> = async (
  app,
  { services },
) => {
  const referrals = new ReferralService(services);
  const doctor = { preHandler: [authenticate(services), requireRole('doctor')] };

  app.post('/appointments/:id/referrals', doctor, async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    const body = CreateReferralBody.parse(request.body);
    return idempotent(services, request, reply, async () => {
      const referral = await referrals.create(request, authOf(request), id, body);
      return { status: 201, body: Referral.parse(referral) };
    });
  });

  app.get('/appointments/:id/referrals', doctor, async (request) => {
    const { id } = IdParams.parse(request.params);
    return VisitReferralList.parse(await referrals.forVisit(request, authOf(request), id));
  });

  app.get('/referrals', doctor, async (request) => {
    const query = ReferralListQuery.parse(request.query);
    return ReferralList.parse(await referrals.list(request, authOf(request), query));
  });

  app.get('/referrals/counts', doctor, async (request) =>
    ReferralCounts.parse(await referrals.counts(authOf(request))),
  );

  app.get('/referrals/:id', doctor, async (request) => {
    const { id } = IdParams.parse(request.params);
    return Referral.parse(await referrals.get(request, authOf(request), id));
  });

  app.post('/referrals/:id/seen', doctor, async (request) => {
    const { id } = IdParams.parse(request.params);
    return Referral.parse(await referrals.markSeen(request, authOf(request), id));
  });

  app.post('/referrals/:id/close', doctor, async (request) => {
    const { id } = IdParams.parse(request.params);
    const body = CloseReferralBody.parse(request.body ?? {});
    return Referral.parse(await referrals.close(request, authOf(request), id, body));
  });
};
