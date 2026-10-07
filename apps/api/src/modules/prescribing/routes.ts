import {
  LastPrescription,
  LastPrescriptionQuery,
  MedicineList,
  MedicineQuery,
  Prescription,
  PrescriptionTemplate,
  PrescriptionTemplateList,
  PrescriptionView,
  SavePrescriptionBody,
  SaveTemplateBody,
} from '@dhc/contracts';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authOf, authenticate, requireRole } from '../../plugins/authenticate';
import type { Services } from '../../services';
import { PrescribingService } from './service';

const IdParams = z.object({ id: z.uuid() });

/** The prescription builder (PRD §6.4, §3.2): doctors only. */
export const prescribingRoutes: FastifyPluginAsync<{ services: Services }> = async (
  app,
  { services },
) => {
  const prescribing = new PrescribingService(services);
  const doctor = { preHandler: [authenticate(services), requireRole('doctor')] };

  app.get('/medicines', doctor, async (request) => {
    const { q } = MedicineQuery.parse(request.query);
    return MedicineList.parse({ data: await prescribing.searchMedicines(authOf(request), q) });
  });

  app.get('/appointments/:id/prescription', doctor, async (request) => {
    const { id } = IdParams.parse(request.params);
    return PrescriptionView.parse(await prescribing.view(request, authOf(request), id));
  });

  app.put('/appointments/:id/prescription', doctor, async (request) => {
    const { id } = IdParams.parse(request.params);
    const body = SavePrescriptionBody.parse(request.body);
    return Prescription.parse(await prescribing.save(request, authOf(request), id, body));
  });

  app.get('/patients/:id/last-prescription', doctor, async (request) => {
    const { id } = IdParams.parse(request.params);
    const { before } = LastPrescriptionQuery.parse(request.query);
    return LastPrescription.parse({
      last: await prescribing.last(request, authOf(request), id, before),
    });
  });

  app.get('/prescription-templates', doctor, async (request) =>
    PrescriptionTemplateList.parse({ data: await prescribing.templates(authOf(request)) }),
  );

  app.post('/prescription-templates', doctor, async (request, reply) => {
    const body = SaveTemplateBody.parse(request.body);
    const saved = await prescribing.saveTemplate(request, authOf(request), body);
    return reply.status(201).send(PrescriptionTemplate.parse(saved));
  });

  app.delete('/prescription-templates/:id', doctor, async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    await prescribing.deleteTemplate(request, authOf(request), id);
    return reply.status(204).send();
  });
};
