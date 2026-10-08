import {
  ApproveMedicineRequestBody,
  DrugMoleculeList,
  DrugMoleculeQuery,
  MasterMedicine,
  MasterMedicineList,
  MasterMedicineQuery,
  MedicineDecisionRow,
  MedicineQueue,
  RejectMedicineRequestBody,
  SaveMedicineBody,
  UpdateMedicineBody,
} from '@dhc/contracts';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authOf, authenticate, requireRole } from '../../plugins/authenticate';
import type { Services } from '../../services';
import { MedicineMasterService } from './service';

const IdParams = z.object({ id: z.uuid() });

/** The medicine master and the free-text approval queue (PRD §9.2, §3.2: clinic admin). */
export const medicineRoutes: FastifyPluginAsync<{ services: Services }> = async (
  app,
  { services },
) => {
  const master = new MedicineMasterService(services);
  const admin = { preHandler: [authenticate(services), requireRole('clinic_admin')] };

  app.get('/medicine-master', admin, async (request) => {
    const query = MasterMedicineQuery.parse(request.query);
    return MasterMedicineList.parse(await master.list(authOf(request), query));
  });

  app.post('/medicine-master', admin, async (request, reply) => {
    const body = SaveMedicineBody.parse(request.body);
    const created = await master.create(request, authOf(request), body);
    return reply.status(201).send(MasterMedicine.parse(created));
  });

  app.put('/medicine-master/:id', admin, async (request) => {
    const { id } = IdParams.parse(request.params);
    const body = UpdateMedicineBody.parse(request.body);
    return MasterMedicine.parse(await master.update(request, authOf(request), id, body));
  });

  app.get('/drug-molecules', admin, async (request) => {
    const { q } = DrugMoleculeQuery.parse(request.query);
    return DrugMoleculeList.parse(await master.molecules(authOf(request), q));
  });

  app.get('/medicine-requests', admin, async (request) =>
    MedicineQueue.parse(await master.queue(authOf(request))),
  );

  app.post('/medicine-requests/approve', admin, async (request, reply) => {
    const body = ApproveMedicineRequestBody.parse(request.body);
    const row = await master.approve(request, authOf(request), body);
    return reply.status(201).send(MedicineDecisionRow.parse(row));
  });

  app.post('/medicine-requests/reject', admin, async (request, reply) => {
    const body = RejectMedicineRequestBody.parse(request.body);
    const row = await master.reject(request, authOf(request), body);
    return reply.status(201).send(MedicineDecisionRow.parse(row));
  });

  app.delete('/medicine-requests/:id', admin, async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    await master.undo(request, authOf(request), id);
    return reply.status(204).send();
  });
};
