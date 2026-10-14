import {
  CreateDisplayScreenBody,
  CreatedDisplayScreen,
  DisplayBoard,
  DisplayScreenList,
  DisplayTokenBody,
  QueueQuery,
  QueueResponse,
  STAFF_ROLES,
} from '@dhc/contracts';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authOf, authenticate, requireRole } from '../../plugins/authenticate';
import type { Services } from '../../services';
import { nextIstMidnight, streamQueue } from '../../sse';
import { istDate } from '@dhc/domain';
import { QueueService } from './service';

const IdParams = z.object({ id: z.uuid() });

/** Screens refresh every few seconds; this leaves room for several per clinic network. */
const SCREEN_RATE_LIMIT = { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } };

/** The live queue for staff, and waiting-room screens (PRD §5.1, §5.3). */
export const queueRoutes: FastifyPluginAsync<{ services: Services }> = async (
  app,
  { services },
) => {
  const queue = new QueueService(services);
  const auth = authenticate(services);
  const staff = { preHandler: [auth, requireRole(...STAFF_ROLES)] };
  const admin = { preHandler: [auth, requireRole('clinic_admin')] };

  app.get('/queue', staff, async (request) => {
    const query = QueueQuery.parse(request.query);
    return QueueResponse.parse(await queue.queue(authOf(request), query));
  });

  // Server-sent events: a `queue` event names each visit that changed; refetch /queue.
  app.get('/queue/stream', staff, async (request, reply) => {
    const { date } = QueueQuery.parse(request.query);
    const now = services.now();
    // A stream for "today" ends at midnight, so the client reconnects to the new day.
    await streamQueue(
      services,
      request,
      reply,
      authOf(request).organisationId,
      date ?? istDate(now),
      {
        endAt: date ? undefined : nextIstMidnight(now),
      },
    );
  });

  app.get('/display-screens', admin, async (request) =>
    DisplayScreenList.parse({ data: await queue.listScreens(authOf(request)) }),
  );

  app.post('/display-screens', admin, async (request, reply) => {
    const body = CreateDisplayScreenBody.parse(request.body);
    const created = await queue.createScreen(request, authOf(request), body);
    return reply.status(201).send(CreatedDisplayScreen.parse(created));
  });

  app.post('/display-screens/:id/revoke', admin, async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    await queue.revokeScreen(request, authOf(request), id);
    return reply.status(204).send();
  });

  // Public: the screen's token is the only credential. Tokens in the body, not the URL.
  app.post('/display/board', SCREEN_RATE_LIMIT, async (request) => {
    const { token } = DisplayTokenBody.parse(request.body);
    return DisplayBoard.parse(await queue.board(token));
  });

  // The screen's live stream: a `queue` event means fetch the board again.
  app.post('/display/stream', SCREEN_RATE_LIMIT, async (request, reply) => {
    const { token } = DisplayTokenBody.parse(request.body);
    const screen = await queue.screen(token);
    const now = services.now();
    // Revoking the screen cuts an open stream off too, not just the next reconnect.
    await streamQueue(services, request, reply, screen.organisationId, istDate(now), {
      clinicId: screen.clinicId,
      endAt: nextIstMidnight(now),
      stillAllowed: () =>
        queue.screen(token).then(
          (s) => s.id === screen.id,
          () => false,
        ),
    });
  });
};
