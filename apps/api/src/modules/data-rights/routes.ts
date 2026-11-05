import { z } from 'zod';
import { withAuth, withTenant } from '@dhc/db';
import {
  RightsCreate,
  RightsList,
  RightsQuery,
  RightsItem,
  RightsPatients,
  RightsAssignment,
  RightsDecision,
  RightsExport,
  ClosureStart,
  ClosureVerify,
  ClosureView,
  RightsReviewers,
} from '@dhc/contracts';
import type { FastifyPluginAsync } from 'fastify';
import type { Services } from '../../services';
import { authenticate, authOf, requireRole } from '../../plugins/authenticate';
import { DataRightsService } from './service';
import { AccountClosureService } from './closure';
import { DataExportService, claimExport } from './export';
const Id = z.object({ id: z.uuid() });
export const dataRightsRoutes: FastifyPluginAsync<{ services: Services }> = async (
  app,
  { services: s },
) => {
  const rights = new DataRightsService(s),
    closure = new AccountClosureService(s),
    exports = new DataExportService(s);
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
    return payload;
  });
  const patient = { preHandler: [authenticate(s), requireRole('patient')] },
    staff = { preHandler: [authenticate(s), requireRole('clinic_admin', 'doctor')] },
    admin = { preHandler: [authenticate(s), requireRole('clinic_admin')] };
  app.get('/data-rights/patients', patient, async (req) =>
    RightsPatients.parse(await rights.patients(authOf(req))),
  );
  app.get(
    '/data-rights',
    { ...staff, preHandler: [authenticate(s), requireRole('patient', 'clinic_admin', 'doctor')] },
    async (req) => RightsList.parse(await rights.list(authOf(req), RightsQuery.parse(req.query))),
  );
  app.post('/data-rights', patient, async (req) =>
    RightsItem.parse(await rights.create(req, authOf(req), RightsCreate.parse(req.body))),
  );
  app.post('/data-rights/:id/withdraw', patient, async (req) =>
    RightsItem.parse(
      await rights.withdraw(
        req,
        authOf(req),
        Id.parse(req.params).id,
        z.object({ revision: z.number().int().positive() }).strict().parse(req.body).revision,
      ),
    ),
  );
  app.post('/data-rights/:id/assign', admin, async (req) =>
    RightsItem.parse(
      await rights.assign(
        req,
        authOf(req),
        Id.parse(req.params).id,
        RightsAssignment.parse(req.body),
      ),
    ),
  );
  app.post('/data-rights/:id/decision', staff, async (req) =>
    RightsItem.parse(
      await rights.decide(
        req,
        authOf(req),
        Id.parse(req.params).id,
        RightsDecision.parse(req.body),
      ),
    ),
  );
  app.get('/data-rights/reviewers', admin, async (req) => {
    const a = authOf(req);
    const ids = await withTenant(s.db, a.organisationId, async (tx) => {
      await rights.staff(tx, a);
      return (
        await tx.membership.findMany({
          where: { role: 'doctor', status: 'active' },
          select: { userId: true },
        })
      ).map((m) => m.userId);
    });
    return RightsReviewers.parse({
      data: await withAuth(s.db, (tx) =>
        tx.user
          .findMany({
            where: { id: { in: ids }, status: 'active' },
            select: { id: true, displayName: true, email: true },
          })
          .then((rows) => rows.map((r) => ({ id: r.id, name: r.displayName ?? r.email }))),
      ),
    });
  });
  app.post(
    '/data-rights/export',
    { ...patient, config: { rateLimit: { max: 6, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const a = authOf(req),
        body = RightsExport.parse(req.body),
        release = claimExport(a);
      let built = false,
        ended = false;
      const finished = () => {
        ended = true;
        if (built) release();
      };
      reply.raw.once('finish', finished);
      reply.raw.once('close', finished);
      try {
        const file = await exports.build(req, a, body);
        built = true;
        if (ended || reply.raw.destroyed) release();
        return reply
          .header('Content-Disposition', `attachment; filename="patient-data-${body.id}.zip"`)
          .type('application/zip')
          .send(file);
      } catch (e) {
        built = true;
        release();
        throw e;
      }
    },
  );
  app.post('/data-rights/closure', patient, async (req) =>
    ClosureView.parse(await closure.start(req, authOf(req), ClosureStart.parse(req.body).id)),
  );
  app.post('/data-rights/closure/:id/verify', { ...patient, logLevel: 'silent' }, async (req) => {
    const b = ClosureVerify.parse(req.body);
    return ClosureView.parse(
      await closure.verify(req, authOf(req), Id.parse(req.params).id, b.code),
    );
  });
};
