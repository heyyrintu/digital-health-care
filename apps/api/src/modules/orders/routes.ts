import {
  AdminTestCatalogueItem,
  AdminTestCatalogueList,
  AwaitingReviewList,
  CreateTestCatalogueItemBody,
  PatientTestOrderList,
  ReorderTestCatalogueBody,
  TestCatalogueList,
  TestCatalogueQuery,
  TestOrder,
  TestOrderListQuery,
  UpdateTestCatalogueItemBody,
} from '@dhc/contracts';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import { idempotent } from '../../idempotency';
import { authOf, authenticate, requireRole } from '../../plugins/authenticate';
import type { Services } from '../../services';
import { TestCatalogueService } from './catalogue';
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

/**
 * Test orders after signing (PRD §7.1): catalogue, lists, results and review; and the
 * clinic admin's catalogue editing (`/test-catalogue/items`).
 */
export const orderRoutes: FastifyPluginAsync<{
  services: Services;
  /** Uploads per client address per minute, shared with the Patient app's. */
  uploadRateLimit: number;
}> = async (app, { services, uploadRateLimit: uploadMax }) => {
  registerUploadParser(app);
  const orders = new OrdersService(services);
  const catalogue = new TestCatalogueService(services);
  const doctor = { preHandler: [authenticate(services), requireRole('doctor')] };
  // The front desk files results that come to the counter (PRD §3.2) but never opens them.
  const desk = { preHandler: [authenticate(services), requireRole('doctor', 'front_desk')] };
  // Uploads authenticate in `onRequest`, before Fastify reads the body: an anonymous or
  // wrong-role request is refused without buffering up to 25 MB.
  const deskUpload = {
    onRequest: [
      uploadRateLimit(app, services, uploadMax),
      authenticate(services),
      requireRole('doctor', 'front_desk'),
    ],
  };

  app.get('/test-catalogue', doctor, async (request) => {
    const { q } = TestCatalogueQuery.parse(request.query);
    return TestCatalogueList.parse({ data: await orders.catalogue(authOf(request), q) });
  });

  // The clinic admin keeps the catalogue (PRD §9.2): every test, active or not.
  const admin = { preHandler: [authenticate(services), requireRole('clinic_admin')] };

  app.get('/test-catalogue/items', admin, async (request) =>
    AdminTestCatalogueList.parse({ data: await catalogue.list(authOf(request)) }),
  );

  app.post('/test-catalogue/items', admin, async (request, reply) => {
    const body = CreateTestCatalogueItemBody.parse(request.body);
    return idempotent(services, request, reply, async () => {
      const item = await catalogue.create(request, authOf(request), body);
      return { status: 201, body: AdminTestCatalogueItem.parse(item) };
    });
  });

  app.patch('/test-catalogue/items/:id', admin, async (request) => {
    const { id } = IdParams.parse(request.params);
    const body = UpdateTestCatalogueItemBody.parse(request.body);
    return AdminTestCatalogueItem.parse(await catalogue.update(request, authOf(request), id, body));
  });

  app.post('/test-catalogue/items/reorder', admin, async (request) => {
    const body = ReorderTestCatalogueBody.parse(request.body);
    return AdminTestCatalogueList.parse({
      data: await catalogue.reorder(request, authOf(request), body),
    });
  });

  app.get('/patients/:id/test-orders', desk, async (request) => {
    const { id } = IdParams.parse(request.params);
    const query = TestOrderListQuery.parse(request.query);
    return PatientTestOrderList.parse(await orders.forPatient(request, authOf(request), id, query));
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
