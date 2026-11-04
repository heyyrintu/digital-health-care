import {
  CreateLibraryDocumentBody,
  DOCUMENT_MEDIA_TYPES,
  DocumentFile,
  LibraryDocument,
  LibraryDocumentList,
  LibraryDocumentQuery,
  MAX_UPLOAD_MB,
  PatientDocument,
  PatientDocumentList,
  PatientDocumentListQuery,
  ShareDocumentBody,
  UpdateLibraryDocumentBody,
} from '@dhc/contracts';
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../errors';
import { idempotent } from '../../idempotency';
import { authOf, authenticate, requireRole } from '../../plugins/authenticate';
import type { Services } from '../../services';
import { sendResultFile } from '../orders/routes';
import { uploadRateLimit, type UploadedFile } from '../orders/upload';
import { REFUSED_DOCUMENT_MEDIA_TYPES } from './content';
import { DocumentsService } from './service';

const IdParams = z.object({ id: z.uuid() });

/**
 * Document bodies are read as raw bytes up to the platform's 25 MB ceiling (413 beyond,
 * before the body is read in full). SVG and HTML are accepted as bodies only to be refused
 * by name.
 */
export const DOCUMENT_BODY_TYPES = [
  ...Object.values(DOCUMENT_MEDIA_TYPES),
  ...REFUSED_DOCUMENT_MEDIA_TYPES,
];

/** Parsers are per plugin: JSON endpoints elsewhere are unaffected. */
export function registerDocumentParser(app: FastifyInstance) {
  app.addContentTypeParser(
    DOCUMENT_BODY_TYPES,
    { parseAs: 'buffer', bodyLimit: MAX_UPLOAD_MB * 1024 * 1024 },
    (_request, body, done) => done(null, body),
  );
}

/** The body as a document file; anything else (JSON, text) is not one. */
function documentFile(request: FastifyRequest): UploadedFile {
  const mediaType = (request.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  if (Buffer.isBuffer(request.body)) return { mediaType, data: request.body };
  if (request.body === undefined && DOCUMENT_BODY_TYPES.includes(mediaType)) {
    return { mediaType, data: Buffer.alloc(0) };
  }
  throw new AppError(
    415,
    'VALIDATION_FAILED',
    'Send the file itself, as a PDF or an image (JPEG, PNG or WebP).',
    { file: 'type_not_allowed' },
  );
}

/**
 * Attachments and the clinic document library (PRD §7.3). Clinic admins and doctors keep
 * the library; doctors share sheets and one-off uploads with patients under the chart model
 * and withdraw them. The front desk has no access: shared documents (reports among them)
 * are clinical content, and the library is only a source for sharing.
 */
export const documentRoutes: FastifyPluginAsync<{
  services: Services;
  /** Uploads per client address per minute, shared with result and logo uploads. */
  uploadRateLimit: number;
}> = async (app, { services, uploadRateLimit: uploadMax }) => {
  registerDocumentParser(app);
  const documents = new DocumentsService(services);
  const library = { preHandler: [authenticate(services), requireRole('doctor', 'clinic_admin')] };
  const doctor = { preHandler: [authenticate(services), requireRole('doctor')] };
  // Authenticated in `onRequest`, before Fastify reads the body (as result uploads are).
  const upload = {
    onRequest: [
      uploadRateLimit(app, services, uploadMax),
      authenticate(services),
      requireRole('doctor', 'clinic_admin'),
    ],
  };

  app.post('/document-files', upload, async (request, reply) => {
    // A client that goes away before the answer: its PDF leaves the rebuild queue.
    const gone = new AbortController();
    const onClose = () => {
      if (!reply.raw.writableFinished) gone.abort();
    };
    reply.raw.once('close', onClose);
    try {
      const file = await documents.uploadFile(
        request,
        authOf(request),
        documentFile(request),
        gone.signal,
      );
      return reply.status(201).send(DocumentFile.parse(file));
    } finally {
      reply.raw.off('close', onClose);
    }
  });

  app.get('/library-documents', library, async (request) => {
    const query = LibraryDocumentQuery.parse(request.query);
    return LibraryDocumentList.parse({ data: await documents.library(authOf(request), query) });
  });

  app.post('/library-documents', library, async (request, reply) => {
    const body = CreateLibraryDocumentBody.parse(request.body);
    return idempotent(services, request, reply, async () => {
      const created = await documents.createLibraryDocument(request, authOf(request), body);
      return { status: 201, body: LibraryDocument.parse(created) };
    });
  });

  app.patch('/library-documents/:id', library, async (request) => {
    const { id } = IdParams.parse(request.params);
    const body = UpdateLibraryDocumentBody.parse(request.body);
    return LibraryDocument.parse(
      await documents.updateLibraryDocument(request, authOf(request), id, body),
    );
  });

  app.get('/library-documents/:id/file', library, async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    return sendResultFile(reply, await documents.libraryFile(authOf(request), id));
  });

  app.get('/patients/:id/documents', doctor, async (request) => {
    const { id } = IdParams.parse(request.params);
    const query = PatientDocumentListQuery.parse(request.query);
    return PatientDocumentList.parse(
      await documents.forPatient(request, authOf(request), id, query),
    );
  });

  app.post('/patients/:id/documents', doctor, async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    const body = ShareDocumentBody.parse(request.body);
    return idempotent(services, request, reply, async () => {
      const shared = await documents.share(request, authOf(request), id, body);
      return { status: 201, body: PatientDocument.parse(shared) };
    });
  });

  app.post('/patient-documents/:id/withdraw', doctor, async (request) => {
    const { id } = IdParams.parse(request.params);
    return PatientDocument.parse(await documents.withdraw(request, authOf(request), id));
  });

  app.get('/patient-documents/:id/file', doctor, async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    return sendResultFile(reply, await documents.file(request, authOf(request), id));
  });
};
