import {
  DOCUMENT_UPLOAD_TTL_HOURS,
  MAX_LIBRARY_DOCUMENTS,
  type CreateLibraryDocumentBody,
  type DocumentFile,
  type DocumentMediaType,
  type LibraryDocument,
  type LibraryDocumentQuery,
  type PatientDocument,
  type PatientDocumentListQuery,
  type PortalDocument,
  type PortalDocumentListQuery,
  type Role,
  type ShareDocumentBody,
  type UpdateLibraryDocumentBody,
} from '@dhc/contracts';
import { withTenant, type Prisma, type Tx } from '@dhc/db';
import type { FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { AppError } from '../../errors';
import { uniqueSuffix } from '../../files';
import type { Services } from '../../services';
import { writeAudit } from '../audit/write';
import { assertChartAccess, TREATED } from '../clinical/access';
import type { UploadedFile } from '../orders/upload';
import { assertNotMerged, historyIds, liveId } from '../patients/merged';
import { staffNames } from '../prescribing/shared';
import { readSettings } from '../settings/service';
import { acceptDocument } from './content';

export interface Actor {
  userId: string;
  organisationId: string;
  role: Role;
}

/**
 * For the patient portal: checks, inside the transaction, that the document's patient is
 * one of the account's (or a record merged into one), and throws 404 otherwise.
 */
export type PatientCheck = (tx: Tx, patientId: string) => Promise<unknown>;

const NOT_FOUND = () => new AppError(404, 'NOT_FOUND', 'Not found.');
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const fileSelect = { select: { mediaType: true, sizeBytes: true } } as const;
const libraryInclude = { file: fileSelect, _count: { select: { shares: true } } } as const;
type LibraryRow = Prisma.LibraryDocumentGetPayload<{ include: typeof libraryInclude }>;
const shareInclude = { file: fileSelect } as const;
type ShareRow = Prisma.PatientDocumentGetPayload<{ include: typeof shareInclude }>;

/** Newest first; the ID breaks ties so a cursor always names one place. */
const shareOrder = [{ sharedAt: 'desc' }, { id: 'asc' }] as const;

/** The opaque cursor is the last document's ID (Prisma resumes from that row's sort values). */
export const encodeDocumentCursor = (id: string) => Buffer.from(id).toString('base64url');
function decodeDocumentCursor(cursor: string): string {
  const id = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!UUID.test(id)) {
    throw new AppError(400, 'VALIDATION_FAILED', 'Invalid cursor.', { cursor: 'invalid' });
  }
  return id;
}
function pageArgs(query: { limit: number; cursor?: string }) {
  return {
    orderBy: [...shareOrder],
    take: query.limit + 1,
    ...(query.cursor ? { cursor: { id: decodeDocumentCursor(query.cursor) }, skip: 1 } : {}),
  };
}
function pageOf<T extends { id: string }>(rows: T[], limit: number) {
  const data = rows.slice(0, limit);
  return {
    data,
    nextCursor: rows.length > limit ? encodeDocumentCursor(data[data.length - 1]!.id) : null,
  };
}

const libraryOut = (row: LibraryRow): LibraryDocument => ({
  id: row.id,
  title: row.title,
  category: row.category,
  language: row.language,
  mediaType: row.file.mediaType as DocumentMediaType,
  sizeBytes: row.file.sizeBytes,
  archived: row.archivedAt !== null,
  archivedAt: row.archivedAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
  shareCount: row._count.shares,
});

/**
 * Attachments and the clinic document library (PRD §7.3). Files are uploaded on their own
 * (`uploadFile`: PDF or still image, within the clinic's limits and checked byte by byte),
 * stored by key with their SHA-256, never changed, and re-hashed on every download. Clinic
 * admins and doctors keep the library: sheets pointing at a file, renamed, given a new file,
 * archived and restored, never deleted. Doctors share a sheet or a one-off upload with a
 * patient under the chart model; a share copies the sheet's title, category and language
 * and points at the exact file it was made with, so later changes to the sheet never reach
 * what the patient already has. Doctors withdraw shares (the record stays). Patients see
 * and open their family's shares that are not withdrawn (`forAccount`, `file` with a
 * `PatientCheck`). Audited by ID only: never titles, notes or file names.
 */
export class DocumentsService {
  constructor(private readonly s: Services) {}

  // ---- Files ------------------------------------------------------------------------

  /**
   * Stores an uploaded document file for later use by the uploader: an image as sent, a PDF
   * as rebuilt from its pages (`acceptDocument`). The file is written
   * before its row, outside the transaction (a slow store holds no connection); if the row
   * then fails to commit, the file is removed again.
   */
  async uploadFile(
    request: FastifyRequest,
    actor: Actor,
    file: UploadedFile,
  ): Promise<DocumentFile> {
    const settings = await withTenant(this.s.db, actor.organisationId, (tx) =>
      readSettings(tx, actor.organisationId),
    );
    // A PDF comes back rebuilt (threat model T27): only those bytes are stored and served.
    const { extension, mediaType, data } = await acceptDocument(settings, file, request.log);
    const digest = sha256(data);
    // No patient data, title or file name in the key (threat model T4).
    const key = `organisations/${actor.organisationId}/documents/${uniqueSuffix()}.${extension}`;
    await this.s.files.put(key, data);
    try {
      return await withTenant(this.s.db, actor.organisationId, async (tx) => {
        const row = await tx.documentFile.create({
          data: {
            organisationId: actor.organisationId,
            fileKey: key,
            mediaType,
            sizeBytes: data.length,
            sha256: digest,
            uploadedByUserId: actor.userId,
            uploadedByRole: actor.role,
            uploadedAt: this.s.now(),
          },
        });
        await this.audit(tx, request, actor, 'document.file_uploaded', 'document_file', row.id, {
          mediaType: row.mediaType,
          sizeBytes: row.sizeBytes,
          sha256: digest,
          by: actor.role,
        });
        return {
          id: row.id,
          mediaType: row.mediaType as DocumentMediaType,
          sizeBytes: row.sizeBytes,
          uploadedAt: row.uploadedAt.toISOString(),
        };
      });
    } catch (error) {
      await this.s.files
        .delete(key)
        .catch((err: unknown) =>
          request.log.error({ err, key }, 'Could not remove the file of a failed document upload'),
        );
      throw error;
    }
  }

  /**
   * Takes a fresh upload for a sheet or a share: the signed-in user's own, not used yet and
   * at most 24 hours old. Marked attached in the same transaction, so it is used once even
   * when two requests race (the second gets 409 `fileId: used`).
   */
  private async claimFile(tx: Tx, actor: Actor, fileId: string) {
    const file = await tx.documentFile.findUnique({ where: { id: fileId } });
    if (!file || file.uploadedByUserId !== actor.userId) {
      throw new AppError(400, 'VALIDATION_FAILED', 'Upload the file again.', { fileId: 'invalid' });
    }
    const now = this.s.now();
    if (now.getTime() - file.uploadedAt.getTime() > DOCUMENT_UPLOAD_TTL_HOURS * 3600_000) {
      throw new AppError(
        400,
        'VALIDATION_FAILED',
        'This upload has expired. Upload the file again.',
        {
          fileId: 'expired',
        },
      );
    }
    const { count } = await tx.documentFile.updateMany({
      where: { id: fileId, attachedAt: null },
      data: { attachedAt: now },
    });
    if (count === 0) {
      throw new AppError(409, 'CONFLICT', 'This upload is already in use. Upload the file again.', {
        fileId: 'used',
      });
    }
    return file;
  }

  /** A stored file, checked against its recorded hash before it is served. */
  private async readFile(file: { id: string; fileKey: string; sha256: string }) {
    const data = await this.s.files.get(file.fileKey);
    if (sha256(data) !== file.sha256) {
      throw new Error(`Stored document file ${file.id} does not match its hash`);
    }
    return data;
  }

  private fileOut(
    data: Buffer,
    file: { mediaType: string; fileKey: string },
    id: string,
  ): { file: Buffer; mediaType: string; filename: string } {
    const extension = file.fileKey.slice(file.fileKey.lastIndexOf('.') + 1);
    return {
      file: data,
      mediaType: file.mediaType,
      filename: `document-${id.slice(0, 8)}.${extension}`,
    };
  }

  // ---- The clinic library -----------------------------------------------------------

  /** The library's active or archived sheets, newest first. Holds no patient data. */
  async library(actor: Actor, query: LibraryDocumentQuery): Promise<LibraryDocument[]> {
    const words = (query.q ?? '').split(/\s+/).filter(Boolean);
    const rows = await withTenant(this.s.db, actor.organisationId, (tx) =>
      tx.libraryDocument.findMany({
        where: {
          archivedAt: query.status === 'archived' ? { not: null } : null,
          ...(query.category ? { category: query.category } : {}),
          AND: words.map((w) => ({ title: { contains: w, mode: 'insensitive' as const } })),
        },
        include: libraryInclude,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      }),
    );
    return rows.map(libraryOut);
  }

  async createLibraryDocument(
    request: FastifyRequest,
    actor: Actor,
    body: CreateLibraryDocumentBody,
  ): Promise<LibraryDocument> {
    return withTenant(this.s.db, actor.organisationId, async (tx) => {
      // One clinic's library is written one request at a time, so the cap holds.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`document-library:${actor.organisationId}`}))`;
      if ((await tx.libraryDocument.count()) >= MAX_LIBRARY_DOCUMENTS) {
        throw new AppError(
          409,
          'CONFLICT',
          `The library holds up to ${MAX_LIBRARY_DOCUMENTS} sheets.`,
          { library: 'full' },
        );
      }
      const file = await this.claimFile(tx, actor, body.fileId);
      const row = await tx.libraryDocument.create({
        data: {
          organisationId: actor.organisationId,
          title: body.title,
          category: body.category,
          language: body.language,
          fileId: file.id,
          createdByUserId: actor.userId,
        },
        include: libraryInclude,
      });
      await this.audit(tx, request, actor, 'document.library_created', 'library_document', row.id, {
        fileId: file.id,
        category: row.category,
        language: row.language,
      });
      return libraryOut(row);
    });
  }

  /**
   * Renames, recategorises, changes the language, replaces the file (a fresh upload; the
   * old file stays for the shares made with it), archives or restores a sheet. An
   * archived sheet changes only by being restored.
   */
  async updateLibraryDocument(
    request: FastifyRequest,
    actor: Actor,
    id: string,
    body: UpdateLibraryDocumentBody,
  ): Promise<LibraryDocument> {
    return withTenant(this.s.db, actor.organisationId, async (tx) => {
      await tx.$queryRaw`SELECT id FROM library_documents WHERE id = ${id}::uuid FOR UPDATE`;
      const before = await tx.libraryDocument.findUnique({ where: { id } });
      if (!before) throw NOT_FOUND();
      const edits = {
        ...(body.title !== undefined && body.title !== before.title ? { title: body.title } : {}),
        ...(body.category !== undefined && body.category !== before.category
          ? { category: body.category }
          : {}),
        ...(body.language !== undefined && body.language !== before.language
          ? { language: body.language }
          : {}),
      };
      const archive = body.archived === true && !before.archivedAt;
      const restore = body.archived === false && before.archivedAt !== null;
      if (before.archivedAt && !restore && (Object.keys(edits).length || body.fileId)) {
        throw new AppError(409, 'CONFLICT', 'Restore the sheet before changing it.', {
          status: 'archived',
        });
      }
      if (!Object.keys(edits).length && !body.fileId && !archive && !restore) {
        // Nothing to change (archiving an archived sheet, a title as it was).
        return libraryOut(
          await tx.libraryDocument.findUniqueOrThrow({ where: { id }, include: libraryInclude }),
        );
      }
      const file = body.fileId ? await this.claimFile(tx, actor, body.fileId) : null;
      const now = this.s.now();
      const row = await tx.libraryDocument.update({
        where: { id },
        data: {
          ...edits,
          ...(file ? { fileId: file.id } : {}),
          ...(archive ? { archivedAt: now, archivedByUserId: actor.userId } : {}),
          ...(restore ? { archivedAt: null, archivedByUserId: null } : {}),
        },
        include: libraryInclude,
      });
      const fields = [...Object.keys(edits), ...(file ? ['file'] : [])];
      if (fields.length) {
        await this.audit(tx, request, actor, 'document.library_updated', 'library_document', id, {
          fields,
          ...(file ? { fileId: file.id, previousFileId: before.fileId } : {}),
        });
      }
      if (archive || restore) {
        await this.audit(
          tx,
          request,
          actor,
          archive ? 'document.library_archived' : 'document.library_restored',
          'library_document',
          id,
          { shares: row._count.shares },
        );
      }
      return libraryOut(row);
    });
  }

  /** A sheet's current file (doctors and clinic admins; holds no patient data). */
  async libraryFile(actor: Actor, id: string) {
    return withTenant(this.s.db, actor.organisationId, async (tx) => {
      const row = await tx.libraryDocument.findUnique({ where: { id }, include: { file: true } });
      if (!row) throw NOT_FOUND();
      return this.fileOut(await this.readFile(row.file), row.file, row.id);
    });
  }

  // ---- Shared with a patient ----------------------------------------------------------

  /**
   * The documents shared with a patient (and with records merged into them), withdrawn ones
   * too, newest first, a page at a time. Doctors, under the chart model. Audited.
   */
  async forPatient(
    request: FastifyRequest,
    actor: Actor,
    patientId: string,
    query: PatientDocumentListQuery,
  ): Promise<{ data: PatientDocument[]; nextCursor: string | null }> {
    const { data: rows, nextCursor } = await withTenant(
      this.s.db,
      actor.organisationId,
      async (tx) => {
        const patient = await tx.patient.findUnique({
          where: { id: patientId },
          select: { id: true, mergedIntoId: true },
        });
        if (!patient) throw NOT_FOUND();
        await assertChartAccess(tx, actor, liveId(patient));
        const ids = await historyIds(tx, liveId(patient));
        const found = await tx.patientDocument.findMany({
          where: {
            patientId: { in: ids },
            ...(query.appointmentId ? { appointmentId: query.appointmentId } : {}),
          },
          include: shareInclude,
          ...pageArgs(query),
        });
        const listed = pageOf(found, query.limit);
        await this.audit(tx, request, actor, 'document.listed', 'patient', patientId, {
          count: listed.data.length,
          ...(query.appointmentId ? { appointmentId: query.appointmentId } : {}),
          ...(query.cursor ? { page: 'next' } : {}),
        });
        return listed;
      },
    );
    return { data: await this.sharesOut(rows), nextCursor };
  }

  /**
   * Shares a library sheet or a fresh upload with a patient, optionally at one of their
   * visits, with an optional note. Doctors, under the chart model; not to a merged record.
   */
  async share(
    request: FastifyRequest,
    actor: Actor,
    patientId: string,
    body: ShareDocumentBody,
  ): Promise<PatientDocument> {
    const row = await withTenant(this.s.db, actor.organisationId, async (tx) => {
      const patient = await tx.patient.findUnique({
        where: { id: patientId },
        select: { id: true, mergedIntoId: true },
      });
      if (!patient) throw NOT_FOUND();
      await assertChartAccess(tx, actor, liveId(patient));
      assertNotMerged(patient);
      if (body.appointmentId) {
        const visit = await tx.appointment.findUnique({
          where: { id: body.appointmentId },
          select: { patientId: true, status: true, consultation: { select: { id: true } } },
        });
        if (visit?.patientId !== patientId) {
          throw new AppError(400, 'VALIDATION_FAILED', 'Choose one of this patient’s visits.', {
            appointmentId: 'invalid',
          });
        }
        // Only a visit that has happened (or has notes): a booking still to come moves to the
        // kept record when the patient is merged, and a document pinned to it would stop that.
        if (!TREATED.includes(visit.status) && !visit.consultation) {
          throw new AppError(
            422,
            'BUSINESS_RULE',
            'Share it from a visit once the patient has checked in, or from the patient’s page.',
            { appointmentId: 'not_seen' },
          );
        }
      }
      let shared: Pick<
        Prisma.PatientDocumentUncheckedCreateInput,
        'title' | 'category' | 'language' | 'fileId' | 'libraryDocumentId'
      >;
      if (body.source === 'library') {
        // Locked, so it cannot be archived or given a new file between this read and the insert.
        await tx.$queryRaw`SELECT id FROM library_documents WHERE id = ${body.libraryDocumentId}::uuid FOR SHARE`;
        const sheet = await tx.libraryDocument.findUnique({
          where: { id: body.libraryDocumentId },
        });
        if (!sheet) {
          throw new AppError(400, 'VALIDATION_FAILED', 'Choose a sheet from the library.', {
            libraryDocumentId: 'invalid',
          });
        }
        if (sheet.archivedAt) {
          throw new AppError(409, 'CONFLICT', 'This sheet is archived. Restore it to share it.', {
            libraryDocumentId: 'archived',
          });
        }
        // A copy of what the sheet is now: renaming or replacing it later changes nothing here.
        shared = {
          title: sheet.title,
          category: sheet.category,
          language: sheet.language,
          fileId: sheet.fileId,
          libraryDocumentId: sheet.id,
        };
      } else {
        const file = await this.claimFile(tx, actor, body.fileId);
        shared = {
          title: body.title,
          category: body.category,
          language: body.language,
          fileId: file.id,
          libraryDocumentId: null,
        };
      }
      const created = await tx.patientDocument.create({
        data: {
          organisationId: actor.organisationId,
          patientId,
          appointmentId: body.appointmentId,
          source: body.source,
          ...shared,
          note: body.note,
          sharedByUserId: actor.userId,
          sharedAt: this.s.now(),
        },
        include: shareInclude,
      });
      await this.audit(tx, request, actor, 'document.shared', 'patient_document', created.id, {
        patientId,
        source: created.source,
        fileId: created.fileId,
        ...(created.libraryDocumentId ? { libraryDocumentId: created.libraryDocumentId } : {}),
        ...(created.appointmentId ? { appointmentId: created.appointmentId } : {}),
        withNote: created.note !== null,
      });
      return created;
    });
    return (await this.sharesOut([row]))[0]!;
  }

  /** Withdraws a share: the patient stops seeing it; the record and its file stay. */
  async withdraw(request: FastifyRequest, actor: Actor, id: string): Promise<PatientDocument> {
    const row = await withTenant(this.s.db, actor.organisationId, async (tx) => {
      await tx.$queryRaw`SELECT id FROM patient_documents WHERE id = ${id}::uuid FOR UPDATE`;
      const doc = await tx.patientDocument.findUnique({ where: { id } });
      if (!doc) throw NOT_FOUND();
      await this.staffAccess(tx, actor, doc.patientId);
      if (doc.withdrawnAt) {
        throw new AppError(409, 'CONFLICT', 'This document is already withdrawn.', {
          status: 'withdrawn',
        });
      }
      const updated = await tx.patientDocument.update({
        where: { id },
        data: { withdrawnAt: this.s.now(), withdrawnByUserId: actor.userId },
        include: shareInclude,
      });
      await this.audit(tx, request, actor, 'document.withdrawn', 'patient_document', id, {
        patientId: doc.patientId,
      });
      return updated;
    });
    return (await this.sharesOut([row]))[0]!;
  }

  /**
   * A shared document's file, checked against its hash. Doctors under the chart model
   * (withdrawn ones too: they stay in the record); through the portal, the patient's family
   * while it is not withdrawn, which also records the first opening. Audited.
   */
  async file(
    request: FastifyRequest,
    actor: Actor,
    id: string,
    allowPatient?: PatientCheck,
  ): Promise<{ file: Buffer; mediaType: string; filename: string }> {
    return withTenant(this.s.db, actor.organisationId, async (tx) => {
      const doc = await tx.patientDocument.findUnique({ where: { id }, include: { file: true } });
      if (!doc) throw NOT_FOUND();
      if (allowPatient) {
        if (doc.withdrawnAt) throw NOT_FOUND();
        await allowPatient(tx, doc.patientId);
      } else {
        await this.staffAccess(tx, actor, doc.patientId);
      }
      const data = await this.readFile(doc.file);
      if (allowPatient && !doc.openedAt) {
        await tx.patientDocument.updateMany({
          where: { id, openedAt: null },
          data: { openedAt: this.s.now() },
        });
      }
      await this.audit(tx, request, actor, 'document.viewed', 'patient_document', id, {
        patientId: doc.patientId,
        fileId: doc.fileId,
        by: allowPatient ? 'patient' : actor.role,
      });
      return this.fileOut(data, doc.file, doc.id);
    });
  }

  /** The family's shared documents for the Patient app and portal, not withdrawn, newest first. */
  async forAccount(
    request: FastifyRequest,
    actor: Actor,
    patients: { id: string; name: string; mergedInto: { id: string; name: string } | null }[],
    query: PortalDocumentListQuery,
  ): Promise<{ data: PortalDocument[]; nextCursor: string | null }> {
    const { data: rows, nextCursor } = await withTenant(
      this.s.db,
      actor.organisationId,
      async (tx) => {
        const found = await tx.patientDocument.findMany({
          where: { patientId: { in: patients.map((p) => p.id) }, withdrawnAt: null },
          include: shareInclude,
          ...pageArgs(query),
        });
        const listed = pageOf(found, query.limit);
        await this.audit(tx, request, actor, 'document.listed', 'account', actor.userId, {
          count: listed.data.length,
          source: 'patient_app',
          ...(query.cursor ? { page: 'next' } : {}),
        });
        return listed;
      },
    );
    const patientOf = new Map(
      patients.map((p) => [p.id, p.mergedInto ?? { id: p.id, name: p.name }]),
    );
    const names = await staffNames(
      this.s.db,
      rows.map((r) => r.sharedByUserId),
    );
    return {
      nextCursor,
      data: rows.map((r) => ({
        id: r.id,
        patient: patientOf.get(r.patientId)!,
        title: r.title,
        category: r.category,
        language: r.language,
        note: r.note,
        mediaType: r.file.mediaType as DocumentMediaType,
        sizeBytes: r.file.sizeBytes,
        sharedAt: r.sharedAt.toISOString(),
        doctorName: names.get(r.sharedByUserId) ?? null,
        isNew: r.openedAt === null,
      })),
    };
  }

  // ---- Helpers ----------------------------------------------------------------------

  /** Staff reach a patient's documents as doctors under the chart model; others never. */
  private async staffAccess(tx: Tx, actor: Actor, patientId: string) {
    if (actor.role !== 'doctor') throw NOT_FOUND();
    const patient = await tx.patient.findUnique({
      where: { id: patientId },
      select: { id: true, mergedIntoId: true },
    });
    await assertChartAccess(tx, actor, patient ? liveId(patient) : patientId);
  }

  private async sharesOut(rows: ShareRow[]): Promise<PatientDocument[]> {
    const names = await staffNames(this.s.db, [
      ...rows.map((r) => r.sharedByUserId),
      ...rows.flatMap((r) => (r.withdrawnByUserId ? [r.withdrawnByUserId] : [])),
    ]);
    return rows.map((r) => ({
      id: r.id,
      patientId: r.patientId,
      appointmentId: r.appointmentId,
      source: r.source,
      libraryDocumentId: r.libraryDocumentId,
      title: r.title,
      category: r.category,
      language: r.language,
      note: r.note,
      mediaType: r.file.mediaType as DocumentMediaType,
      sizeBytes: r.file.sizeBytes,
      sharedAt: r.sharedAt.toISOString(),
      sharedBy: { userId: r.sharedByUserId, name: names.get(r.sharedByUserId) ?? null },
      openedAt: r.openedAt?.toISOString() ?? null,
      withdrawnAt: r.withdrawnAt?.toISOString() ?? null,
      withdrawnBy: r.withdrawnByUserId
        ? { userId: r.withdrawnByUserId, name: names.get(r.withdrawnByUserId) ?? null }
        : null,
    }));
  }

  private audit(
    tx: Tx,
    request: FastifyRequest,
    actor: Actor,
    action: string,
    entityType: string,
    entityId: string,
    metadata?: Prisma.InputJsonValue,
  ) {
    return writeAudit(tx, request, {
      action,
      organisationId: actor.organisationId,
      actorUserId: actor.userId,
      entityType,
      entityId,
      metadata,
    });
  }
}
