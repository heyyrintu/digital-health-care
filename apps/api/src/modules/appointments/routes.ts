import {
  AppointmentActionBody,
  AppointmentDetail,
  AppointmentList,
  AppointmentListQuery,
  CreateAppointmentBody,
  RescheduleAppointmentBody,
  STAFF_ROLES,
} from '@dhc/contracts';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authOf, authenticate, requireRole } from '../../plugins/authenticate';
import type { Services } from '../../services';
import { AppointmentService } from './service';

const IdParams = z.object({ id: z.uuid() });

/**
 * Appointments and walk-ins (PRD §3.2): front desk, doctors and clinic admins book,
 * reschedule and cancel; the service narrows each status change to its roles.
 */
export const appointmentRoutes: FastifyPluginAsync<{ services: Services }> = async (
  app,
  { services },
) => {
  const appointments = new AppointmentService(services);
  const auth = authenticate(services);
  const staff = { preHandler: [auth, requireRole(...STAFF_ROLES)] };

  app.get('/appointments', staff, async (request) => {
    const query = AppointmentListQuery.parse(request.query);
    return AppointmentList.parse({ data: await appointments.list(authOf(request), query) });
  });

  app.get('/appointments/:id', staff, async (request) => {
    const { id } = IdParams.parse(request.params);
    return AppointmentDetail.parse(await appointments.view(authOf(request), id));
  });

  app.post('/appointments', staff, async (request, reply) => {
    const body = CreateAppointmentBody.parse(request.body);
    const created = await appointments.create(request, authOf(request), body);
    return reply.status(201).send(AppointmentDetail.parse(created));
  });

  app.post('/appointments/:id/actions', staff, async (request) => {
    const { id } = IdParams.parse(request.params);
    const body = AppointmentActionBody.parse(request.body);
    return AppointmentDetail.parse(await appointments.act(request, authOf(request), id, body));
  });

  app.post('/appointments/:id/reschedule', staff, async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    const body = RescheduleAppointmentBody.parse(request.body);
    const moved = await appointments.reschedule(request, authOf(request), id, body);
    return reply.status(201).send(AppointmentDetail.parse(moved));
  });
};
