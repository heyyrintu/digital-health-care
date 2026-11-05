import { z } from 'zod';
import type { FastifyPluginAsync } from 'fastify';
import {
  PreviewClinicOperation,
  ApplyClinicOperation,
  ClinicOperation,
  ClinicOperationList,
  ClinicOperationOptions,
  STAFF_ROLES,
} from '@dhc/contracts';
import type { Services } from '../../services';
import { authOf, authenticate, requireRole } from '../../plugins/authenticate';
import { ClinicOperationsService } from './service';
const Id = z.object({ id: z.uuid() });
export const clinicOperationRoutes: FastifyPluginAsync<{ services: Services }> = async (
  app,
  { services: s },
) => {
  const service = new ClinicOperationsService(s),
    staff = { preHandler: [authenticate(s), requireRole(...STAFF_ROLES)] };
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('Cache-Control', 'no-store');
    return payload;
  });
  app.get('/clinic-operations/options', staff, async (req) =>
    ClinicOperationOptions.parse(await service.options(authOf(req))),
  );
  app.get('/clinic-operations', staff, async (req) =>
    ClinicOperationList.parse(
      await service.list(
        authOf(req),
        z.object({ cursor: z.uuid().optional() }).parse(req.query).cursor,
      ),
    ),
  );
  app.get('/clinic-operations/:id', staff, async (req) =>
    ClinicOperation.parse(await service.view(authOf(req), Id.parse(req.params).id)),
  );
  app.post('/clinic-operations/preview', staff, async (req) =>
    ClinicOperation.parse(
      await service.preview(req, authOf(req), PreviewClinicOperation.parse(req.body)),
    ),
  );
  app.post('/clinic-operations/:id/apply', staff, async (req) =>
    ClinicOperation.parse(
      await service.apply(
        req,
        authOf(req),
        Id.parse(req.params).id,
        ApplyClinicOperation.parse(req.body),
      ),
    ),
  );
};
