import { z } from 'zod';
import { withTenant } from '@dhc/db';
import type { FastifyPluginAsync } from 'fastify';
import {
  InboxQuery,
  InboxList,
  InboxMessages,
  InboxThread,
  InboxReply,
  InboxMessage,
  InboxAction,
  InboxAssign,
  InboxConsent,
  InboxTemplates,
  InboxTemplate,
  InboxTemplateToggle,
  InboxDoctors,
} from '@dhc/contracts';
import type { Services } from '../../services';
import { authOf, authenticate, requireRole } from '../../plugins/authenticate';
import { InboxService } from './service';
import { dispatchInbox } from './dispatch';
const Id = z.object({ id: z.uuid() });
export const inboxRoutes: FastifyPluginAsync<{ services: Services }> = async (
  app,
  { services: s },
) => {
  const inbox = new InboxService(s),
    staff = { preHandler: [authenticate(s), requireRole('front_desk', 'doctor', 'clinic_admin')] },
    admin = { preHandler: [authenticate(s), requireRole('clinic_admin')] };
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('Cache-Control', 'no-store');
    return payload;
  });
  app.get('/inbox', staff, async (req) =>
    InboxList.parse(await inbox.list(authOf(req), InboxQuery.parse(req.query))),
  );
  app.get('/inbox/doctors', staff, async (req) =>
    InboxDoctors.parse(await inbox.doctors(authOf(req))),
  );
  app.get('/inbox/threads/:id/messages', staff, async (req) =>
    InboxMessages.parse(
      await inbox.messages(req, authOf(req), Id.parse(req.params).id, InboxQuery.parse(req.query)),
    ),
  );
  app.post('/inbox/threads/:id/action', staff, async (req) =>
    InboxThread.parse(
      await inbox.action(req, authOf(req), Id.parse(req.params).id, InboxAction.parse(req.body)),
    ),
  );
  app.post('/inbox/threads/:id/assign', staff, async (req) =>
    InboxThread.parse(
      await inbox.assign(req, authOf(req), Id.parse(req.params).id, InboxAssign.parse(req.body)),
    ),
  );
  app.post('/inbox/threads/:id/consent', staff, async (req) =>
    InboxThread.parse(
      await inbox.consent(req, authOf(req), Id.parse(req.params).id, InboxConsent.parse(req.body)),
    ),
  );
  app.post(
    '/inbox/threads/:id/messages',
    { ...staff, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req) => {
      const a = authOf(req),
        r = await inbox.enqueue(req, a, Id.parse(req.params).id, InboxReply.parse(req.body));
      await dispatchInbox(s, a.organisationId, r.id);
      return withTenant(s.db, a.organisationId, async (tx) => {
        await inbox.thread(tx, a, Id.parse(req.params).id, true);
        return InboxMessage.parse(
          inbox.message(await tx.inboxMessage.findUniqueOrThrow({ where: { id: r.id } })),
        );
      });
    },
  );
  app.get('/inbox/templates', staff, async (req) =>
    InboxTemplates.parse(await inbox.templates(authOf(req))),
  );
  app.post(
    '/inbox/templates/sync',
    { ...admin, config: { rateLimit: { max: 3, timeWindow: '1 minute' } } },
    async (req) => InboxTemplates.parse(await inbox.sync(req, authOf(req))),
  );
  app.post('/inbox/templates/:id', admin, async (req) =>
    InboxTemplate.parse(
      await inbox.toggle(
        req,
        authOf(req),
        Id.parse(req.params).id,
        InboxTemplateToggle.parse(req.body),
      ),
    ),
  );
};
