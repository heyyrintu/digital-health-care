import {
  PortalProfile,
  UpdatePortalProfile,
  PatientReportedEntry,
  StartPhoneChange,
  VerifyPhoneChange,
  PhoneChangeView,
} from '@dhc/contracts';
import { PortalProfileService } from './profile';
import { PatientPhoneChangeService } from './phone-change';
import { CreatePrepaidBooking, PrepaidBookingView } from '@dhc/contracts';
import { PrepaidBookingService } from '../../payments/prepaid';
import {
  AcceptConsentsBody,
  BookingOptions,
  BookingOptionsQuery,
  ConsentStatus,
  CreatePortalPatientBody,
  PortalAppointment,
  PortalAppointmentList,
  PortalBookBody,
  PortalDocumentList,
  PortalDocumentListQuery,
  PortalCancelBody,
  PortalRescheduleBody,
  PortalPatient,
  PortalPatientList,
  PortalPrescriptionList,
  PortalSlotsQuery,
  PortalTestOrderList,
  TestOrderListQuery,
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
import { PortalDocumentsService } from './documents';
import { PortalOrdersService } from './orders';
import { PortalService } from './service';

const IdParams = z.object({ id: z.uuid() });

/** The Patient app and web portal (PRD §4): patients only, and only their own family. */
export const portalRoutes: FastifyPluginAsync<{
  services: Services;
  /** Uploads per client address per minute, shared with the staff routes'. */
  uploadRateLimit: number;
}> = async (app, { services, uploadRateLimit: uploadMax }) => {
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('Cache-Control', 'no-store');
    return payload;
  });
  const portal = new PortalService(services);
  const booking = new PortalBookingService(services);
  const orders = new PortalOrdersService(services);
  const documents = new PortalDocumentsService(services);
  registerUploadParser(app);
  app.addContentTypeParser(
    'image/webp',
    { parseAs: 'buffer', bodyLimit: 512 * 1024 },
    (_request, body, done) => done(null, body),
  );
  const patientOnly = { preHandler: [authenticate(services), requireRole('patient')] };

  const profiles = new PortalProfileService(services);
  const phones = new PatientPhoneChangeService(services);
  app.get('/portal/patients/:id/profile', patientOnly, async (request) =>
    PortalProfile.parse(
      await profiles.view(request, authOf(request), IdParams.parse(request.params).id),
    ),
  );
  app.put('/portal/patients/:id/profile', patientOnly, async (request) =>
    PortalProfile.parse(
      await profiles.update(
        request,
        authOf(request),
        IdParams.parse(request.params).id,
        UpdatePortalProfile.parse(request.body),
      ),
    ),
  );
  app.post('/portal/patients/:id/medical-basics', patientOnly, async (request, reply) => {
    const id = IdParams.parse(request.params).id;
    const body = PatientReportedEntry.parse(request.body);
    return idempotent(services, request, reply, async () => ({
      status: 201,
      body: PortalProfile.parse(await profiles.report(request, authOf(request), id, body)),
    }));
  });
  app.get('/portal/patients/:id/photo', patientOnly, async (request, reply) => {
    const file = await profiles.photoBytes(
      request,
      authOf(request),
      IdParams.parse(request.params).id,
    );
    return reply
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .type(file.mediaType)
      .send(file.data);
  });
  app.post(
    '/portal/patients/:id/photo',
    { ...patientOnly, bodyLimit: 512 * 1024, onRequest: uploadRateLimit(app, services, uploadMax) },
    async (request) =>
      PortalProfile.parse(
        await profiles.photo(
          request,
          authOf(request),
          IdParams.parse(request.params).id,
          uploadedFile(request),
        ),
      ),
  );
  app.delete('/portal/patients/:id/photo', patientOnly, async (request) =>
    PortalProfile.parse(
      await profiles.photo(request, authOf(request), IdParams.parse(request.params).id),
    ),
  );
  app.post(
    '/portal/patients/:id/phone-change',
    { ...patientOnly, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request) =>
      PhoneChangeView.parse(
        await phones.start(
          request,
          authOf(request),
          IdParams.parse(request.params).id,
          StartPhoneChange.parse(request.body),
        ),
      ),
  );
  app.post(
    '/portal/phone-changes/:id/verify',
    { ...patientOnly, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request) =>
      PhoneChangeView.parse(
        await phones.verify(
          request,
          authOf(request),
          IdParams.parse(request.params).id,
          VerifyPhoneChange.parse(request.body),
        ),
      ),
  );

  const prepaid = new PrepaidBookingService(services);
  app.post('/portal/prepaid-bookings', patientOnly, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return PrepaidBookingView.parse(
      await prepaid.create(request, authOf(request), CreatePrepaidBooking.parse(request.body)),
    );
  });
  app.get('/portal/prepaid-bookings/:id', patientOnly, async (request) =>
    PrepaidBookingView.parse(
      await prepaid.view(authOf(request), IdParams.parse(request.params).id),
    ),
  );
  for (const action of ['check', 'close'] as const)
    app.post(`/portal/prepaid-bookings/:id/${action}`, patientOnly, async (request) =>
      PrepaidBookingView.parse(
        await prepaid.check(
          request,
          authOf(request),
          IdParams.parse(request.params).id,
          action === 'close',
        ),
      ),
    );

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
    BookingOptions.parse(
      await booking.options(
        authOf(request),
        BookingOptionsQuery.parse(request.query).prepaid === 'true',
      ),
    ),
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

  app.get('/portal/appointments/:id', patientOnly, async (request) => {
    const { id } = IdParams.parse(request.params);
    return PortalAppointment.parse(await booking.view(authOf(request), id));
  });

  app.post('/portal/appointments/:id/reschedule', patientOnly, async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    const body = PortalRescheduleBody.parse(request.body);
    return idempotent(services, request, reply, async () => ({
      status: 201,
      body: PortalAppointment.parse(await booking.reschedule(request, authOf(request), id, body)),
    }));
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
  app.get('/portal/test-orders', patientOnly, async (request) => {
    const query = TestOrderListQuery.parse(request.query);
    return PortalTestOrderList.parse(await orders.list(request, authOf(request), query));
  });

  app.post(
    '/portal/test-orders/:id/results',
    // Authenticated before the body is read (see orders/routes.ts).
    {
      onRequest: [
        uploadRateLimit(app, services, uploadMax),
        authenticate(services),
        requireRole('patient'),
      ],
    },
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

  // Documents doctors shared (PRD §7.3): the family's, not withdrawn; opening marks them opened.
  app.get('/portal/documents', patientOnly, async (request) => {
    const query = PortalDocumentListQuery.parse(request.query);
    return PortalDocumentList.parse(await documents.list(request, authOf(request), query));
  });

  app.get('/portal/documents/:id/file', patientOnly, async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    return sendResultFile(reply, await documents.file(request, authOf(request), id));
  });
};
