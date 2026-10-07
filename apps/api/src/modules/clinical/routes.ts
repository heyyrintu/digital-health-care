import {
  Allergy,
  ConsultationRecord,
  ConsultationView,
  CreateAllergyBody,
  CreateConditionBody,
  CreateMedicationBody,
  CurrentMedication,
  MedicalCondition,
  PatientChart,
  RemoveChartEntryBody,
  SaveConsultationBody,
  Vitals,
  VitalsBody,
  VitalsResponse,
} from '@dhc/contracts';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authOf, authenticate, requireRole } from '../../plugins/authenticate';
import type { Services } from '../../services';
import { ClinicalService, type ChartKind } from './service';

const IdParams = z.object({ id: z.uuid() });
const EntryParams = z.object({ id: z.uuid(), entryId: z.uuid() });

/**
 * The clinical record (PRD §6.1, §3.2): chart and consultation notes for doctors;
 * vitals for doctors and front desk. Clinic admins have no clinical access.
 */
export const clinicalRoutes: FastifyPluginAsync<{ services: Services }> = async (
  app,
  { services },
) => {
  const clinical = new ClinicalService(services);
  const auth = authenticate(services);
  const doctor = { preHandler: [auth, requireRole('doctor')] };
  const vitalsTeam = { preHandler: [auth, requireRole('doctor', 'front_desk')] };

  app.get('/patients/:id/chart', doctor, async (request) => {
    const { id } = IdParams.parse(request.params);
    return PatientChart.parse(await clinical.chart(request, authOf(request), id));
  });

  app.post('/patients/:id/allergies', doctor, async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    const body = CreateAllergyBody.parse(request.body);
    const created = await clinical.addAllergy(request, authOf(request), id, body);
    return reply.status(201).send(Allergy.parse(created));
  });

  app.post('/patients/:id/conditions', doctor, async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    const body = CreateConditionBody.parse(request.body);
    const created = await clinical.addCondition(request, authOf(request), id, body);
    return reply.status(201).send(MedicalCondition.parse(created));
  });

  app.post('/patients/:id/medications', doctor, async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    const body = CreateMedicationBody.parse(request.body);
    const created = await clinical.addMedication(request, authOf(request), id, body);
    return reply.status(201).send(CurrentMedication.parse(created));
  });

  for (const kind of ['allergies', 'conditions', 'medications'] as const satisfies ChartKind[]) {
    app.post(`/patients/:id/${kind}/:entryId/remove`, doctor, async (request, reply) => {
      const { id, entryId } = EntryParams.parse(request.params);
      const { reason } = RemoveChartEntryBody.parse(request.body);
      await clinical.removeEntry(request, authOf(request), id, kind, entryId, reason);
      return reply.status(204).send();
    });
  }

  app.get('/appointments/:id/vitals', vitalsTeam, async (request) => {
    const { id } = IdParams.parse(request.params);
    return VitalsResponse.parse({ vitals: await clinical.vitals(request, authOf(request), id) });
  });

  app.put('/appointments/:id/vitals', vitalsTeam, async (request) => {
    const { id } = IdParams.parse(request.params);
    const body = VitalsBody.parse(request.body);
    return Vitals.parse(await clinical.saveVitals(request, authOf(request), id, body));
  });

  app.get('/appointments/:id/consultation', doctor, async (request) => {
    const { id } = IdParams.parse(request.params);
    return ConsultationView.parse(await clinical.consultation(request, authOf(request), id));
  });

  app.put('/appointments/:id/consultation', doctor, async (request) => {
    const { id } = IdParams.parse(request.params);
    const body = SaveConsultationBody.parse(request.body);
    return ConsultationRecord.parse(await clinical.save(request, authOf(request), id, body));
  });
};
