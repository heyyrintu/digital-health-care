import {
  AwaitingReviewList,
  PatientTestOrderList,
  TestCatalogueList,
  TestCatalogueQuery,
  TestOrder,
} from '@dhc/contracts';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import { authOf, authenticate, requireRole } from '../../plugins/authenticate';
import type { Services } from '../../services';
import { OrdersService } from './service';
import { registerUploadParser, uploadedFile, uploadRateLimit } from './upload';

const IdParams = z.object({ id: z.uuid() });

/**
 * An uploaded result, served so a browser cannot run it as a page: its stored type, no
 * sniffing, a sandbox, and never cached.
 */
export const sendResultFile = (
  reply: FastifyReply,
  result: { file: Buffer; mediaType: string; filename: string },
) =>
  reply
    .type(result.mediaType)
    .header('Content-Disposition', `inline; filename="${result.filename}"`)
    .header('Cache-Control', 'no-store')
    .header('X-Content-Type-Options', 'nosniff')
    .header('Content-Security-Policy', "default-src 'none'; img-src 'self'; sandbox")
    .send(result.file);

/** Test orders after signing (PRD §7.1): catalogue, lists, results and review. */
export const orderRoutes: FastifyPluginAsync<{ services: Services }> = async (
  app,
  { services },
) => {
  registerUploadParser(app);
  const orders = new OrdersService(services);
  const doctor = { preHandler: [authenticate(services), requireRole('doctor')] };
  // The front desk files results that come to the counter (PRD §3.2) but never opens them.
  const desk = { preHandler: [authenticate(services), requireRole('doctor', 'front_desk')] };
  // Uploads authenticate in `onRequest`, before Fastify reads the body: an anonymous or
  // wrong-role request is refused without buffering up to 25 MB.
  const deskUpload = {
    onRequest: [
      uploadRateLimit(app, services),
      authenticate(services),
      requireRole('doctor', 'front_desk'),
    ],
  };

  app.get('/test-catalogue', doctor, async (request) => {
    const { q } = TestCatalogueQuery.parse(request.query);
    return TestCatalogueList.parse({ data: await orders.catalogue(authOf(request), q) });
  });

  app.get('/patients/:id/test-orders', desk, async (request) => {
    const { id } = IdParams.parse(request.params);
    return PatientTestOrderList.parse({
      data: await orders.forPatient(request, authOf(request), id),
    });
  });

  app.get('/test-orders/awaiting-review', doctor, async (request) =>
    AwaitingReviewList.parse(await orders.awaitingReview(authOf(request))),
  );

  app.post('/test-orders/:id/results', deskUpload, async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    const order = await orders.upload(request, authOf(request), id, uploadedFile(request));
    return reply.status(201).send(TestOrder.parse(order));
  });

  app.post('/test-orders/:id/review', doctor, async (request) => {
    const { id } = IdParams.parse(request.params);
    return TestOrder.parse(await orders.review(request, authOf(request), id));
  });

  app.get('/test-results/:id/file', doctor, async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    return sendResultFile(reply, await orders.resultFile(request, authOf(request), id));
  });
};
