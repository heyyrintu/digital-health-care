import {
  AvailabilityException,
  AvailabilityExceptionList,
  AvailabilityExceptionQuery,
  AvailabilityQuery,
  AvailabilityVersion,
  AvailabilityVersionList,
  BookingRules,
  Clinic,
  ClinicList,
  ConsultationType,
  ConsultationTypeList,
  CreateAvailabilityExceptionBody,
  CreateAvailabilityVersionBody,
  CreateClinicBody,
  CreateConsultationTypeBody,
  DoctorList,
  STAFF_ROLES,
  SlotsQuery,
  SlotsResponse,
  UpdateClinicBody,
  UpdateConsultationTypeBody,
} from '@dhc/contracts';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authOf, authenticate, requireRole } from '../../plugins/authenticate';
import type { Services } from '../../services';
import { AvailabilityService } from './availability';
import { SchedulingSettingsService } from './settings';

const IdParams = z.object({ id: z.uuid() });

/**
 * Clinics, consultation types, booking rules, doctor availability and slots (PRD §4.3).
 * Clinic admins configure; doctors manage their own availability; all staff can read.
 */
export const schedulingRoutes: FastifyPluginAsync<{ services: Services }> = async (
  app,
  { services },
) => {
  const settings = new SchedulingSettingsService(services);
  const availability = new AvailabilityService(services);
  const auth = authenticate(services);
  const staff = { preHandler: [auth, requireRole(...STAFF_ROLES)] };
  const admin = { preHandler: [auth, requireRole('clinic_admin')] };
  // The service narrows further: a doctor acts only on their own schedule.
  const scheduler = { preHandler: [auth, requireRole('doctor', 'clinic_admin')] };

  app.get('/clinics', staff, async (request) =>
    ClinicList.parse({ data: await settings.listClinics(authOf(request)) }),
  );

  app.post('/clinics', admin, async (request, reply) => {
    const body = CreateClinicBody.parse(request.body);
    const clinic = await settings.createClinic(request, authOf(request), body);
    return reply.status(201).send(Clinic.parse(clinic));
  });

  app.patch('/clinics/:id', admin, async (request) => {
    const { id } = IdParams.parse(request.params);
    const body = UpdateClinicBody.parse(request.body);
    return Clinic.parse(await settings.updateClinic(request, authOf(request), id, body));
  });

  app.get('/consultation-types', staff, async (request) =>
    ConsultationTypeList.parse({ data: await settings.listConsultationTypes(authOf(request)) }),
  );

  app.post('/consultation-types', admin, async (request, reply) => {
    const body = CreateConsultationTypeBody.parse(request.body);
    const type = await settings.createConsultationType(request, authOf(request), body);
    return reply.status(201).send(ConsultationType.parse(type));
  });

  app.patch('/consultation-types/:id', admin, async (request) => {
    const { id } = IdParams.parse(request.params);
    const body = UpdateConsultationTypeBody.parse(request.body);
    return ConsultationType.parse(
      await settings.updateConsultationType(request, authOf(request), id, body),
    );
  });

  app.get('/booking-rules', staff, async (request) =>
    BookingRules.parse(await settings.bookingRules(authOf(request))),
  );

  app.put('/booking-rules', admin, async (request) => {
    const body = BookingRules.parse(request.body);
    return BookingRules.parse(await settings.updateBookingRules(request, authOf(request), body));
  });

  app.get('/doctors', staff, async (request) =>
    DoctorList.parse({ data: await settings.listDoctors(authOf(request)) }),
  );

  app.get('/availability/versions', staff, async (request) => {
    const query = AvailabilityQuery.parse(request.query);
    return AvailabilityVersionList.parse({
      data: await availability.listVersions(authOf(request), query),
    });
  });

  app.post('/availability/versions', scheduler, async (request, reply) => {
    const body = CreateAvailabilityVersionBody.parse(request.body);
    const version = await availability.createVersion(request, authOf(request), body);
    return reply.status(201).send(AvailabilityVersion.parse(version));
  });

  app.delete('/availability/versions/:id', scheduler, async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    await availability.deleteVersion(request, authOf(request), id);
    return reply.status(204).send();
  });

  app.get('/availability/exceptions', staff, async (request) => {
    const query = AvailabilityExceptionQuery.parse(request.query);
    return AvailabilityExceptionList.parse({
      data: await availability.listExceptions(authOf(request), query),
    });
  });

  app.post('/availability/exceptions', scheduler, async (request, reply) => {
    const body = CreateAvailabilityExceptionBody.parse(request.body);
    const exception = await availability.createException(request, authOf(request), body);
    return reply.status(201).send(AvailabilityException.parse(exception));
  });

  app.delete('/availability/exceptions/:id', scheduler, async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    await availability.deleteException(request, authOf(request), id);
    return reply.status(204).send();
  });

  app.get('/slots', staff, async (request) => {
    const query = SlotsQuery.parse(request.query);
    return SlotsResponse.parse(await availability.slots(authOf(request), query));
  });
};
