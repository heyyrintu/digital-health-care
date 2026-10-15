import {
  AcceptConsentsBody,
  ConsentStatus,
  CreatePortalPatientBody,
  PortalPatient,
  PortalPatientList,
} from '@dhc/contracts';
import type { FastifyPluginAsync } from 'fastify';
import { authOf, authenticate, requireRole } from '../../plugins/authenticate';
import type { Services } from '../../services';
import { PortalService } from './service';

/** The Patient app and web portal (PRD §4): patients only, and only their own family. */
export const portalRoutes: FastifyPluginAsync<{ services: Services }> = async (
  app,
  { services },
) => {
  const portal = new PortalService(services);
  const patientOnly = { preHandler: [authenticate(services), requireRole('patient')] };

  app.get('/portal/consents', patientOnly, async (request) =>
    ConsentStatus.parse(await portal.consents(authOf(request))),
  );

  app.post('/portal/consents', patientOnly, async (request) => {
    const body = AcceptConsentsBody.parse(request.body);
    return ConsentStatus.parse(await portal.acceptConsents(request, authOf(request), body));
  });

  app.post('/portal/consents/health_data/withdraw', patientOnly, async (request) =>
    ConsentStatus.parse(await portal.withdrawHealthData(request, authOf(request))),
  );

  app.get('/portal/patients', patientOnly, async (request) =>
    PortalPatientList.parse({ data: await portal.patients(authOf(request)) }),
  );

  app.post('/portal/patients', patientOnly, async (request, reply) => {
    const body = CreatePortalPatientBody.parse(request.body);
    const created = await portal.addPatient(request, authOf(request), body);
    return reply.status(201).send(PortalPatient.parse(created));
  });
};
