import { PeopleService } from './people';
import { StaffContactService } from './contact-changes';
import {
  PeopleList,
  PeopleQuery,
  PeopleDetail,
  UpdatePeopleBody,
  RequestStaffContactBody,
  StaffContactChange,
  StaffContactChanges,
  ConfirmStaffContactBody,
  StaffContactConfirmed,
} from '@dhc/contracts';
import {
  CreatedStaffInvite,
  PracticeIdentity,
  STAFF_ROLES,
  ResetAuthenticatorBody,
  SignOutAllResponse,
  StaffMemberList,
  StaffSessionList,
} from '@dhc/contracts';
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

  const people = new PeopleService(services);
  const contacts = new StaffContactService(services);
  const staffAuth = { preHandler: [authenticate(services), requireRole(...STAFF_ROLES)] };
  const limitedAdmin = { ...admin, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };
  app.get('/staff/people', admin, async (request) =>
    PeopleList.parse(await people.list(authOf(request), PeopleQuery.parse(request.query))),
  );
  app.get('/staff/people/:id', admin, async (request) =>
    PeopleDetail.parse(await people.get(authOf(request), IdParams.parse(request.params).id)),
  );
  app.patch('/staff/people/:id', admin, async (request) =>
    PeopleDetail.parse(
      await people.update(
        request,
        authOf(request),
        IdParams.parse(request.params).id,
        UpdatePeopleBody.parse(request.body),
      ),
    ),
  );
  app.get('/staff/people/:id/contact-changes', admin, async (request) =>
    StaffContactChanges.parse(
      await contacts.listChanges(authOf(request), IdParams.parse(request.params).id),
    ),
  );
  app.post('/staff/people/:id/contact-changes', limitedAdmin, async (request, reply) =>
    reply
      .status(201)
      .send(
        StaffContactChange.parse(
          await contacts.request(
            request,
            authOf(request),
            IdParams.parse(request.params).id,
            RequestStaffContactBody.parse(request.body),
          ),
        ),
      ),
  );
  app.post('/staff/people/:id/contact-changes/:changeId/cancel', admin, async (request, reply) => {
    const params = z.object({ id: z.uuid(), changeId: z.uuid() }).parse(request.params);
    await contacts.cancel(request, authOf(request), params.id, params.changeId);
    return reply.status(204).send();
  });
  app.get('/staff/profile/contact-changes', staffAuth, async (request) =>
    StaffContactChanges.parse(await contacts.listChanges(authOf(request))),
  );
  app.post(
    '/staff/profile/contact-changes/:id/confirm',
    { ...staffAuth, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request) =>
      StaffContactConfirmed.parse(
        await contacts.confirm(
          request,
          authOf(request),
          IdParams.parse(request.params).id,
          ConfirmStaffContactBody.parse(request.body),
        ),
      ),
  );

  app.put(
    '/staff/profile',
    { preHandler: [authenticate(services), requireRole(...STAFF_ROLES)] },
    async (request) => {
      const body = PracticeIdentity.parse(request.body);
      await staff.renameSelf(request, authOf(request), body.name);
      return body;
    },
  );

  app.get('/staff/members', admin, async (request) =>
    StaffMemberList.parse({ data: await staff.list(authOf(request)) }),
  );

  app.post('/staff/members/:id/reset-authenticator', admin, async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    const body = ResetAuthenticatorBody.parse(request.body ?? {});
    const created = await staff.resetAuthenticator(request, authOf(request), id, body);
    return reply.status(201).send(CreatedStaffInvite.parse(created));
  });

  app.get('/staff/members/:id/sessions', admin, async (request) => {
    const { id } = IdParams.parse(request.params);
    return StaffSessionList.parse({ data: await staff.sessions(authOf(request), id) });
  });

  app.post('/staff/members/:id/sign-out-all', admin, async (request) => {
    const { id } = IdParams.parse(request.params);
    return SignOutAllResponse.parse(await staff.signOutAll(request, authOf(request), id));
  });

  app.post('/staff/sessions/:id/revoke', admin, async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    await staff.revokeSession(request, authOf(request), id);
    return reply.status(204).send();
  });
};
