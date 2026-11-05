import { z } from 'zod';
import {
  PatientRecord,
  PatientRecordList,
  PatientRecordQuery,
  CreatePatientRecord,
  UpdatePatientRecord,
  RecordOptions,
  CreateRecordShare,
  RecordShare,
  RecordShareList,
  ResolveRecordShare,
  RecordRevision,
  UsePatientRecord,
  RecordPhotoPages,
  documentFileName,
} from '@dhc/contracts';
import type { FastifyPluginAsync } from 'fastify';
import { authOf, authenticate, requireRole } from '../../plugins/authenticate';
import type { Services } from '../../services';
import { registerDocumentParser } from '../documents/routes';
import { uploadedFile, uploadRateLimit } from '../orders/upload';
import { sendResultFile } from '../orders/routes';
import { PatientRecordsService } from './service';
const Id = z.object({ id: z.uuid() }),
  ShareId = z.object({ id: z.uuid(), shareId: z.uuid() });
export const patientRecordRoutes: FastifyPluginAsync<{
  services: Services;
  uploadRateLimit: number;
}> = async (app, { services, uploadRateLimit: uploadMax }) => {
  registerDocumentParser(app);
  const records = new PatientRecordsService(services);
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
    return payload;
  });
  const patient = { preHandler: [authenticate(services), requireRole('patient')] },
    doctor = { preHandler: [authenticate(services), requireRole('doctor')] };
  app.get('/portal/patients/:id/record-options', patient, async (req) =>
    RecordOptions.parse(await records.options(authOf(req), Id.parse(req.params).id)),
  );
  app.get('/portal/records', patient, async (req) =>
    PatientRecordList.parse(
      await records.list(req, authOf(req), PatientRecordQuery.parse(req.query)),
    ),
  );
  app.post('/portal/patients/:id/records', patient, async (req) =>
    PatientRecord.parse(
      await records.create(
        req,
        authOf(req),
        Id.parse(req.params).id,
        CreatePatientRecord.parse(req.body),
      ),
    ),
  );
  app.get('/portal/records/:id', patient, async (req) =>
    PatientRecord.parse(await records.view(req, authOf(req), Id.parse(req.params).id)),
  );
  app.patch('/portal/records/:id', patient, async (req) =>
    PatientRecord.parse(
      await records.update(
        req,
        authOf(req),
        Id.parse(req.params).id,
        UpdatePatientRecord.parse(req.body),
      ),
    ),
  );
  app.post(
    '/portal/records/:id/file',
    { ...patient, onRequest: uploadRateLimit(app, services, uploadMax) },
    async (req) =>
      PatientRecord.parse(
        await records.upload(req, authOf(req), Id.parse(req.params).id, uploadedFile(req)),
      ),
  );
  app.post(
    '/portal/records/:id/photo-pages',
    { ...patient, bodyLimit: 15 * 1048576, onRequest: uploadRateLimit(app, services, uploadMax) },
    async (req) =>
      PatientRecord.parse(
        await records.photos(
          req,
          authOf(req),
          Id.parse(req.params).id,
          RecordPhotoPages.parse(req.body),
        ),
      ),
  );
  app.get('/portal/records/:id/file', patient, async (req, reply) => {
    const f = await records.file(req, authOf(req), Id.parse(req.params).id);
    return sendResultFile(reply, {
      file: f.data,
      mediaType: f.mediaType,
      filename: documentFileName(1, f.mediaType),
    });
  });
  app.delete('/portal/records/:id', patient, async (req) =>
    PatientRecord.parse(await records.hide(req, authOf(req), Id.parse(req.params).id)),
  );
  app.post('/portal/records/:id/restore', patient, async (req) =>
    PatientRecord.parse(await records.hide(req, authOf(req), Id.parse(req.params).id, true)),
  );
  app.get('/portal/records/:id/shares', patient, async (req) =>
    RecordShareList.parse(await records.shares(authOf(req), Id.parse(req.params).id)),
  );
  app.post('/portal/records/:id/shares', patient, async (req) =>
    RecordShare.parse(
      await records.share(
        req,
        authOf(req),
        Id.parse(req.params).id,
        CreateRecordShare.parse(req.body),
      ),
    ),
  );
  app.delete('/portal/records/:id/shares/:shareId', patient, async (req) => {
    const { id, shareId } = ShareId.parse(req.params);
    return records.revoke(req, authOf(req), id, shareId);
  });
  app.get('/patients/:id/records', doctor, async (req) =>
    PatientRecordList.parse(
      await records.list(
        req,
        authOf(req),
        PatientRecordQuery.parse(req.query),
        Id.parse(req.params).id,
      ),
    ),
  );
  app.post(
    '/record-shares/resolve',
    { ...doctor, logLevel: 'silent', config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req) =>
      PatientRecord.parse(
        await records.resolve(req, authOf(req), ResolveRecordShare.parse(req.body).token),
      ),
  );
  app.get('/patient-records/:id', doctor, async (req) =>
    PatientRecord.parse(await records.view(req, authOf(req), Id.parse(req.params).id, true)),
  );
  app.get('/patient-records/:id/file', doctor, async (req, reply) => {
    const f = await records.file(req, authOf(req), Id.parse(req.params).id, true);
    return sendResultFile(reply, {
      file: f.data,
      mediaType: f.mediaType,
      filename: documentFileName(1, f.mediaType),
    });
  });
  app.post('/patient-records/:id/review', doctor, async (req) =>
    PatientRecord.parse(
      await records.review(
        req,
        authOf(req),
        Id.parse(req.params).id,
        RecordRevision.parse(req.body).revision,
      ),
    ),
  );
  app.post('/patient-records/:id/use', doctor, async (req) => {
    const body = UsePatientRecord.parse(req.body);
    return PatientRecord.parse(
      await records.review(
        req,
        authOf(req),
        Id.parse(req.params).id,
        body.revision,
        body.appointmentId,
      ),
    );
  });
};
