import { DashboardQuery, DashboardReport } from '@dhc/contracts';
import type { FastifyPluginAsync } from 'fastify';
import { authOf, authenticate, requireRole } from '../../plugins/authenticate';
import type { Services } from '../../services';
import { ReportsService } from './service';

/** The clinic admin's dashboard figures (PRD §9.2). */
export const reportRoutes: FastifyPluginAsync<{ services: Services }> = async (
  app,
  { services },
) => {
  const reports = new ReportsService(services);
  app.get(
    '/dashboard',
    { preHandler: [authenticate(services), requireRole('clinic_admin')] },
    async (request) =>
      DashboardReport.parse(
        await reports.dashboard(
          authOf(request).organisationId,
          DashboardQuery.parse(request.query),
        ),
      ),
  );
};
