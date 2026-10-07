import {
  CreatePatientBody,
  CreateTagBody,
  DuplicateCheckBody,
  DuplicateCheckResponse,
  PatientDetail,
  PatientListQuery,
  PatientListResponse,
  STAFF_ROLES,
  SetPatientTagsBody,
  Tag,
  TagList,
  UhidSettings,
  UpdatePatientBody,
  UpdateTagBody,
  UpdateUhidSettingsBody,
} from '@dhc/contracts';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../errors';
import { authOf, authenticate, requireRole } from '../../plugins/authenticate';
import type { Services } from '../../services';
import { PatientService } from './service';
import { TagService } from './tags';

const IdParams = z.object({ id: z.uuid() });

/**
 * Patient register and its settings. PRD §3.2: front desk, doctors and clinic admins
 * register patients; front desk and doctors assign tags; clinic admins configure tags
 * and UHIDs.
 */
export const patientRoutes: FastifyPluginAsync<{ services: Services }> = async (
  app,
  { services },
) => {
  const patients = new PatientService(services);
  const tags = new TagService(services);
  const auth = authenticate(services);
  const staff = { preHandler: [auth, requireRole(...STAFF_ROLES)] };
  const registrar = { preHandler: [auth, requireRole('front_desk', 'doctor', 'clinic_admin')] };
  const tagger = { preHandler: [auth, requireRole('front_desk', 'doctor')] };
  const admin = { preHandler: [auth, requireRole('clinic_admin')] };

  app.get('/patients', staff, async (request) => {
    const query = PatientListQuery.parse(request.query);
    const { data, lastId } = await patients.list(authOf(request), query, decodeCursor);
    return PatientListResponse.parse({ data, nextCursor: lastId ? encodeCursor(lastId) : null });
  });

  app.get('/patients/:id', staff, async (request) => {
    const { id } = IdParams.parse(request.params);
    return PatientDetail.parse(await patients.view(request, authOf(request), id));
  });

  app.post('/patients', registrar, async (request, reply) => {
    const body = CreatePatientBody.parse(request.body);
    const created = await patients.create(request, authOf(request), body);
    return reply.status(201).send(PatientDetail.parse(created));
  });

  app.patch('/patients/:id', registrar, async (request) => {
    const { id } = IdParams.parse(request.params);
    const body = UpdatePatientBody.parse(request.body);
    return PatientDetail.parse(await patients.update(request, authOf(request), id, body));
  });

  app.post('/patients/duplicate-check', registrar, async (request) => {
    const body = DuplicateCheckBody.parse(request.body);
    return DuplicateCheckResponse.parse({
      candidates: await patients.duplicates(authOf(request), body),
    });
  });

  app.put('/patients/:id/tags', tagger, async (request) => {
    const { id } = IdParams.parse(request.params);
    const { tagIds } = SetPatientTagsBody.parse(request.body);
    return PatientDetail.parse(await patients.setTags(request, authOf(request), id, tagIds));
  });

  app.get('/tags', staff, async (request) =>
    TagList.parse({ data: await tags.list(authOf(request)) }),
  );

  app.post('/tags', admin, async (request, reply) => {
    const body = CreateTagBody.parse(request.body);
    return reply.status(201).send(Tag.parse(await tags.create(request, authOf(request), body)));
  });

  app.patch('/tags/:id', admin, async (request) => {
    const { id } = IdParams.parse(request.params);
    const body = UpdateTagBody.parse(request.body);
    return Tag.parse(await tags.update(request, authOf(request), id, body));
  });

  app.post('/tags/defaults', admin, async (request) =>
    TagList.parse({ data: await tags.addDefaults(request, authOf(request)) }),
  );

  app.get('/uhid-settings', staff, async (request) =>
    UhidSettings.parse(await patients.uhidSettings(authOf(request))),
  );

  app.put('/uhid-settings', admin, async (request) => {
    const body = UpdateUhidSettingsBody.parse(request.body);
    return UhidSettings.parse(await patients.updateUhidSettings(request, authOf(request), body));
  });
};

const encodeCursor = (id: string) => Buffer.from(id).toString('base64url');

function decodeCursor(cursor: string): string {
  const id = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!z.uuid().safeParse(id).success)
    throw new AppError(400, 'VALIDATION_FAILED', 'Invalid cursor.', { cursor: 'invalid' });
  return id;
}
