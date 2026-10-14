import { OrganisationSettings, STAFF_ROLES, UpdateOrganisationSettingsBody } from '@dhc/contracts';
import type { FastifyPluginAsync } from 'fastify';
import { authOf, authenticate, requireRole } from '../../plugins/authenticate';
import type { Services } from '../../services';
import { SettingsService } from './service';

/** Clinic admin settings (PRD §9.2). Every staff role reads them; only clinic admins change them. */
export const settingsRoutes: FastifyPluginAsync<{ services: Services }> = async (
  app,
  { services },
) => {
  const settings = new SettingsService(services);
  const auth = authenticate(services);

  app.get(
    '/organisation-settings',
    { preHandler: [auth, requireRole(...STAFF_ROLES)] },
    async (request) => OrganisationSettings.parse(await settings.get(authOf(request))),
  );

  app.put(
    '/organisation-settings',
    { preHandler: [auth, requireRole('clinic_admin')] },
    async (request) => {
      const body = UpdateOrganisationSettingsBody.parse(request.body);
      return OrganisationSettings.parse(await settings.update(request, authOf(request), body));
    },
  );
};
