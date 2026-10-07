import {
  AcceptInviteBody,
  CompleteInviteBody,
  CreateStaffInviteBody,
  CreatedStaffInvite,
  InviteDetails,
  InviteTokenBody,
  StaffInviteList,
} from '@dhc/contracts';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authOf, authenticate, requireRole } from '../../plugins/authenticate';
import type { Services } from '../../services';
import { InviteService } from './service';

export interface InviteRoutesOptions {
  services: Services;
  /** Requests per IP per minute on the public invite endpoints. */
  signInRateLimit: number;
}

const IdParams = z.object({ id: z.uuid() });

export const inviteRoutes: FastifyPluginAsync<InviteRoutesOptions> = async (
  app,
  { services, signInRateLimit },
) => {
  const invites = new InviteService(services);
  const admin = { preHandler: [authenticate(services), requireRole('clinic_admin')] };
  const limited = { config: { rateLimit: { max: signInRateLimit, timeWindow: '1 minute' } } };

  app.post('/staff/invites', admin, async (request, reply) => {
    const body = CreateStaffInviteBody.parse(request.body);
    const created = await invites.create(request, authOf(request), body);
    return reply.status(201).send(CreatedStaffInvite.parse(created));
  });

  app.get('/staff/invites', admin, async (request) =>
    StaffInviteList.parse({ data: await invites.list(authOf(request)) }),
  );

  app.post('/staff/invites/:id/revoke', admin, async (request, reply) => {
    await invites.revoke(request, authOf(request), IdParams.parse(request.params).id);
    return reply.status(204).send();
  });

  app.post('/auth/invites/inspect', limited, async (request) =>
    InviteDetails.parse(await invites.inspect(InviteTokenBody.parse(request.body).token)),
  );

  app.post('/auth/invites/accept', limited, async (request) => {
    const body = AcceptInviteBody.parse(request.body);
    return invites.accept(request, body.token, body.password);
  });

  app.post('/auth/invites/complete', limited, async (request) => {
    const body = CompleteInviteBody.parse(request.body);
    return invites.complete(request, body.token, body.code);
  });
};
