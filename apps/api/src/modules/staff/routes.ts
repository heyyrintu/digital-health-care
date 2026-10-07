import { CreatedStaffInvite, ResetAuthenticatorBody, StaffMemberList } from '@dhc/contracts';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authOf, authenticate, requireRole } from '../../plugins/authenticate';
import type { Services } from '../../services';
import { StaffService } from './service';

const IdParams = z.object({ id: z.uuid() });

export const staffRoutes: FastifyPluginAsync<{ services: Services }> = async (
  app,
  { services },
) => {
  const staff = new StaffService(services);
  const admin = { preHandler: [authenticate(services), requireRole('clinic_admin')] };

  app.get('/staff/members', admin, async (request) =>
    StaffMemberList.parse({ data: await staff.list(authOf(request)) }),
  );

  app.post('/staff/members/:id/reset-authenticator', admin, async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    const body = ResetAuthenticatorBody.parse(request.body ?? {});
    const created = await staff.resetAuthenticator(request, authOf(request), id, body);
    return reply.status(201).send(CreatedStaffInvite.parse(created));
  });
};
