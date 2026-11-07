import {
  ApplyPatientImport,
  PatientImport,
  PatientImportList,
  PreviewPatientImport,
} from '@dhc/contracts';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authenticate, authOf, requireRole } from '../../plugins/authenticate';
import type { Services } from '../../services';
import { PatientImportsService } from './service';
export const patientImportRoutes: FastifyPluginAsync<{ services: Services }> = async (
  app,
  { services },
) => {
  const service = new PatientImportsService(services),
    auth = { preHandler: [authenticate(services), requireRole('clinic_admin')] },
    params = z.object({ id: z.uuid() });
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('Cache-Control', 'no-store');
    return payload;
  });
  app.get('/patient-imports', auth, async (r) =>
    PatientImportList.parse(await service.list(authOf(r))),
  );
  app.get('/patient-imports/:id', auth, async (r) =>
    PatientImport.parse(await service.read(r, authOf(r), params.parse(r.params).id)),
  );
  const mutation = { ...auth, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };
  app.post('/patient-imports/preview', mutation, async (r) =>
    PatientImport.parse(await service.preview(r, authOf(r), PreviewPatientImport.parse(r.body))),
  );
  app.post('/patient-imports/:id/apply', mutation, async (r) => {
    ApplyPatientImport.parse(r.body);
    return PatientImport.parse(await service.apply(r, authOf(r), params.parse(r.params).id));
  });
  app.post('/patient-imports/:id/cancel', mutation, async (r) =>
    PatientImport.parse(await service.cancel(r, authOf(r), params.parse(r.params).id)),
  );
};
