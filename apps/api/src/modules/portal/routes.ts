import {
  AcceptConsentsBody,
  BookingOptions,
  ConsentStatus,
  CreatePortalPatientBody,
  PortalAppointment,
  PortalAppointmentList,
  PortalBookBody,
  PortalCancelBody,
  PortalPatient,
  PortalPatientList,
  PortalPrescriptionList,
  PortalSlotsQuery,
  PortalTestOrderList,
  SlotsResponse,
  TestOrder,
} from '@dhc/contracts';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authOf, authenticate, requireRole } from '../../plugins/authenticate';
import { idempotent } from '../../idempotency';
import type { Services } from '../../services';
import { sendResultFile } from '../orders/routes';
import { registerUploadParser, uploadedFile, uploadRateLimit } from '../orders/upload';
import { sendPdf } from '../prescribing/routes';
import { PortalBookingService } from './booking';
import { PortalOrdersService } from './orders';
import { PortalService } from './service';

const IdParams = z.object({ id: z.uuid() });

/** The Patient app and web portal (PRD §4): patients only, and only their own family. */
export const portalRoutes: FastifyPluginAsync<{ services: Services }> = async (
  app,
  { services },
) => {
  const portal = new PortalService(services);
  const booking = new PortalBookingService(services);
  const orders = new PortalOrdersService(services);
  registerUploadParser(app);
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

  app.get('/portal/booking-options', patientOnly, async (request) =>
    BookingOptions.parse(await booking.options(authOf(request))),
  );

  app.get('/portal/slots', patientOnly, async (request) => {
    const query = PortalSlotsQuery.parse(request.query);
    return SlotsResponse.parse(await booking.slots(authOf(request), query));
  });

  app.get('/portal/appointments', patientOnly, async (request) =>
    PortalAppointmentList.parse(await booking.list(authOf(request))),
  );

  app.post('/portal/appointments', patientOnly, async (request, reply) => {
    const body = PortalBookBody.parse(request.body);
    // A phone on a weak network retries the same booking with the same key.
    return idempotent(services, request, reply, async () => {
      const created = await booking.book(request, authOf(request), body);
      return { status: 201, body: PortalAppointment.parse(created) };
    });
  });

  app.post('/portal/appointments/:id/cancel', patientOnly, async (request) => {
    const { id } = IdParams.parse(request.params);
    const body = PortalCancelBody.parse(request.body ?? {});
    return PortalAppointment.parse(await booking.cancel(request, authOf(request), id, body));
  });

  app.get('/portal/prescriptions', patientOnly, async (request) =>
    PortalPrescriptionList.parse({ data: await booking.prescriptions(authOf(request)) }),
  );

  app.get('/portal/prescriptions/:id/pdf', patientOnly, async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    const { file, filename } = await booking.prescriptionPdf(request, authOf(request), id);
    return sendPdf(reply, file, filename);
  });

  // Test orders (PRD §4.4, §7.1): what was ordered, and results uploaded against it.
  app.get('/portal/test-orders', patientOnly, async (request) =>
    PortalTestOrderList.parse({ data: await orders.list(request, authOf(request)) }),
  );

  app.post(
    '/portal/test-orders/:id/results',
    // Authenticated before the body is read (see orders/routes.ts).
    { onRequest: [uploadRateLimit(app, services), authenticate(services), requireRole('patient')] },
    async (request, reply) => {
      const { id } = IdParams.parse(request.params);
      const order = await orders.upload(request, authOf(request), id, uploadedFile(request));
      return reply.status(201).send(TestOrder.parse(order));
    },
  );

  app.get('/portal/test-results/:id/file', patientOnly, async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    return sendResultFile(reply, await orders.resultFile(request, authOf(request), id));
  });
};
