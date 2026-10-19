import {
  CloseReferralBody,
  CreateReferralBody,
  Referral,
  ReferralCounts,
  ReferralLetterCheck,
  ReferralLetterPreviewQuery,
  ReferralList,
  ReferralListQuery,
  SignReferralLetterBody,
  VerifyReferralLetterBody,
  VisitReferralList,
} from '@dhc/contracts';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { idempotent } from '../../idempotency';
import { authOf, authenticate, requireRole } from '../../plugins/authenticate';
import type { Services } from '../../services';
import { sendPdf, VERIFY_RATE_LIMIT } from '../prescribing/routes';
import { ReferralLetterService } from './letter';
import { ReferralService } from './service';

const IdParams = z.object({ id: z.uuid() });

/**
 * Referrals (PRD §7.2): made from a visit by its doctor, listed for the doctors who sent
 * and received them, marked seen by the receiving doctor and closed by either; the
 * referring doctor signs a letter, which both doctors download and anyone holding it can
 * check by its QR. Doctors only: the front desk and clinic admins have no clinical access
 * (PRD §3.2).
 */
export const referralRoutes: FastifyPluginAsync<{
  services: Services;
  /** Requests checking a PIN, per client address per minute. */
  signInRateLimit: number;
}> = async (app, { services, signInRateLimit }) => {
  const PIN_RATE_LIMIT = { rateLimit: { max: signInRateLimit, timeWindow: '1 minute' } };
  const referrals = new ReferralService(services);
  const letters = new ReferralLetterService(services);
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

  app.get('/referrals/:id/letter/preview', doctor, async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    const { language } = ReferralLetterPreviewQuery.parse(request.query);
    const file = await letters.preview(request, authOf(request), id, language);
    return sendPdf(reply, file, 'referral-letter-preview.pdf');
  });

  app.post('/referrals/:id/letter/sign', { ...doctor, config: PIN_RATE_LIMIT }, async (request) => {
    const { id } = IdParams.parse(request.params);
    const body = SignReferralLetterBody.parse(request.body);
    return Referral.parse(await letters.sign(request, authOf(request), id, body));
  });

  app.get('/referrals/:id/letter', doctor, async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    const { file, filename } = await letters.pdf(request, authOf(request), id);
    return sendPdf(reply, file, filename);
  });

  // Public: the code from the letter's QR is the only key. In the body, not the URL, so it
  // stays out of access logs.
  app.post('/verify/referral-letter', VERIFY_RATE_LIMIT, async (request) => {
    const { code } = VerifyReferralLetterBody.parse(request.body);
    return ReferralLetterCheck.parse(await letters.verify(code));
  });
};
