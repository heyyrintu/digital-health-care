import {
  PatientRecord as RecordContract,
  RecordDetails,
  type PatientRecord,
  type PatientRecordQuery,
  type CreatePatientRecord,
  type UpdatePatientRecord,
  type CreateRecordShare,
  type RecordShare,
  type RecordPhotoPages,
  type Role,
  documentTypesFor,
  CURRENT_CONSENT_VERSIONS,
} from '@dhc/contracts';
import { withTenant, type Prisma, type Tx } from '@dhc/db';
import { createHash, randomBytes } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../../errors';
import { uniqueSuffix } from '../../files';
import type { Services } from '../../services';
import { writeAudit } from '../audit/write';
import { TREATED } from '../clinical/access';
import { acceptDocument } from '../documents/content';
import { inspectImage } from '../branding/logo';
import { historyIds, liveId } from '../patients/merged';
import { accountPhone, ownPatient, ownHistory, accountHistoryWhere } from '../portal/account';
import { PortalService } from '../portal/service';
import { readSettings } from '../settings/service';
import type { UploadedFile } from '../orders/upload';
import { staffNames } from '../prescribing/shared';

type Actor = { userId: string; organisationId: string; role?: Role };
type Row = Prisma.PatientRecordGetPayload<object>;
const patientSelect = {
  id: true,
  name: true,
  mergedInto: { select: { id: true, name: true } },
} as const;
type Names = {
  patients: Map<string, Prisma.PatientGetPayload<{ select: typeof patientSelect }>>;
  names: Map<string, string | null>;
};
const missing = () => new AppError(404, 'NOT_FOUND', 'Not found.');
const conflict = (message: string) => new AppError(409, 'CONFLICT', message);
const hash = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const order = [{ createdAt: 'desc' }, { id: 'asc' }] as const;
const buildingPhotoPdfs = new Set<string>();
export class PatientRecordsService {
  constructor(private readonly s: Services) {}
  private async owner(tx: Tx, actor: Actor, id: string) {
    await new PortalService(this.s).requireConsents(tx, actor);
    const r = await tx.patientRecord.findUnique({ where: { id } });
    if (!r) throw missing();
    await ownHistory(tx, await accountPhone(this.s, actor.userId), r.patientId);
    return r;
  }
  private async lock(tx: Tx, id: string) {
    await tx.$queryRaw`SELECT id FROM patient_records WHERE id=${id}::uuid FOR UPDATE`;
  }
  private async grantors(tx: Tx, ids: string[]) {
    const rows = await tx.accountConsent.findMany({
      where: {
        userId: { in: ids },
        withdrawnAt: null,
        OR: Object.entries(CURRENT_CONSENT_VERSIONS).map(([kind, version]) => ({ kind, version })),
      },
    });
    const kinds = new Map<string, Set<string>>();
    for (const row of rows) {
      const set = kinds.get(row.userId) ?? new Set<string>();
      set.add(row.kind);
      kinds.set(row.userId, set);
    }
    return new Set([...kinds].filter(([, set]) => set.size === 3).map(([id]) => id));
  }
  private async doctor(tx: Tx, actor: Actor, r: Row) {
    if (
      actor.role !== 'doctor' ||
      r.state !== 'ready' ||
      !(await tx.membership.count({
        where: { userId: actor.userId, role: 'doctor', status: 'active' },
      }))
    )
      throw missing();
    if (await tx.patientRecordUse.count({ where: { recordId: r.id, doctorUserId: actor.userId } }))
      return;
    const shares = r.hiddenAt
      ? []
      : await tx.patientRecordShare.findMany({
          where: {
            recordId: r.id,
            doctorUserId: actor.userId,
            revokedAt: null,
            expiresAt: { gt: this.s.now() },
          },
        });
    const valid = await this.grantors(
      tx,
      shares.map((s) => s.createdByUserId),
    );
    if (!shares.some((s) => valid.has(s.createdByUserId))) throw missing();
  }
  private async links(
    tx: Tx,
    patientId: string,
    appointmentId: string | null,
    testOrderId: string | null,
  ) {
    const ids = await historyIds(tx, patientId);
    if (
      appointmentId &&
      !(await tx.appointment.count({ where: { id: appointmentId, patientId: { in: ids } } }))
    )
      throw missing();
    if (testOrderId) {
      const o = await tx.testOrder.findFirst({
        where: { id: testOrderId, patientId: { in: ids }, orderedAt: { not: null } },
      });
      if (!o || (appointmentId && o.appointmentId !== appointmentId)) throw missing();
    }
  }
  async options(actor: Actor, patientId: string) {
    const phone = await accountPhone(this.s, actor.userId);
    return withTenant(this.s.db, actor.organisationId, async (tx) => {
      await new PortalService(this.s).requireConsents(tx, actor);
      await ownPatient(tx, phone, patientId);
      const settings = await readSettings(tx, actor.organisationId),
        ids = await historyIds(tx, patientId);
      const members = await tx.membership.findMany({
        where: { role: 'doctor', status: 'active' },
        select: { userId: true },
        take: 200,
      });
      const names = await staffNames(
        this.s.db,
        members.map((m) => m.userId),
      );
      return {
        maxUploadMb: settings.maxUploadMb,
        uploadTypes: documentTypesFor(settings),
        doctors: members.map((m) => ({ id: m.userId, name: names.get(m.userId) ?? null })),
        appointments: (
          await tx.appointment.findMany({
            where: { patientId: { in: ids } },
            orderBy: { startAt: 'desc' },
            take: 200,
            select: { id: true, date: true },
          })
        ).map((a) => ({ id: a.id, date: a.date.toISOString().slice(0, 10) })),
        orders: await tx.testOrder.findMany({
          where: { patientId: { in: ids }, orderedAt: { not: null } },
          orderBy: { orderedAt: 'desc' },
          take: 200,
          select: { id: true, name: true, appointmentId: true },
        }),
      };
    });
  }
  async create(
    request: FastifyRequest,
    actor: Actor,
    patientId: string,
    body: CreatePatientRecord,
  ) {
    const phone = await accountPhone(this.s, actor.userId),
      { id, ...meta } = body,
      createHash = hash(JSON.stringify([patientId, meta]));
    return withTenant(this.s.db, actor.organisationId, async (tx) => {
      await new PortalService(this.s).requireConsents(tx, actor);
      await ownPatient(tx, phone, patientId);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`patient-record:${id}`},0))`;
      const prior = await tx.patientRecord.findUnique({ where: { id } });
      if (prior) {
        await this.owner(tx, actor, id);
        if (prior.createHash !== createHash)
          throw conflict('This upload request was already used.');
        return this.out(tx, prior);
      }
      await this.links(tx, patientId, body.appointmentId, body.testOrderId);
      const r = await tx.patientRecord.create({
        data: {
          id,
          organisationId: actor.organisationId,
          patientId,
          createdByUserId: actor.userId,
          createHash,
          detailsCipher: this.s.cipher.encrypt(
            JSON.stringify({ title: body.title, note: body.note }),
          ),
          category: body.category,
          recordDate: body.recordDate ? new Date(body.recordDate) : null,
          appointmentId: body.appointmentId,
          testOrderId: body.testOrderId,
          createdAt: this.s.now(),
          uploadExpiresAt: new Date(this.s.now().getTime() + 86400000),
        },
      });
      await this.audit(tx, request, actor, r.id, 'record.created');
      return this.out(tx, r);
    });
  }
  async upload(
    request: FastifyRequest,
    actor: Actor,
    id: string,
    file: UploadedFile,
    sourceHash = hash(file.data),
  ) {
    const before = await withTenant(this.s.db, actor.organisationId, async (tx) => {
      const r = await this.owner(tx, actor, id);
      if (r.hiddenAt) throw missing();
      if (r.state === 'ready') {
        if (r.sourceSha256 !== sourceHash) throw conflict('An uploaded file cannot be replaced.');
        return { r, settings: null };
      }
      if (r.state !== 'awaiting_upload' || r.uploadExpiresAt <= this.s.now())
        throw conflict('This upload expired. Start another upload.');
      return { r, settings: await readSettings(tx, actor.organisationId) };
    });
    if (!before.settings)
      return withTenant(this.s.db, actor.organisationId, async (tx) =>
        this.out(tx, await this.owner(tx, actor, id)),
      );
    const accepted = await acceptDocument(before.settings, file, {
      pdf: this.s.pdf,
      organisationId: actor.organisationId,
      log: request.log,
    });
    const key = `organisations/${actor.organisationId}/patient-records/${id}-${uniqueSuffix()}.${accepted.extension}`;
    await this.s.files.put(key, accepted.data);
    let keep = false;
    try {
      return await withTenant(this.s.db, actor.organisationId, async (tx) => {
        await this.lock(tx, id);
        const r = await this.owner(tx, actor, id);
        if (r.hiddenAt) throw missing();
        if (r.state === 'ready') {
          if (r.sourceSha256 !== sourceHash) throw conflict('An uploaded file cannot be replaced.');
          return this.out(tx, r);
        }
        if (r.state !== 'awaiting_upload' || r.uploadExpiresAt <= this.s.now())
          throw conflict('This upload expired.');
        const updated = await tx.patientRecord.update({
          where: { id },
          data: {
            state: 'ready',
            fileKey: key,
            mediaType: accepted.mediaType,
            sizeBytes: accepted.data.length,
            sha256: hash(accepted.data),
            sourceSha256: sourceHash,
          },
        });
        keep = true;
        await this.audit(tx, request, actor, id, 'record.uploaded');
        return this.out(tx, updated);
      });
    } catch (error) {
      // Re-read after a possibly lost COMMIT. Never remove a referenced upload.
      try {
        keep =
          (
            await withTenant(this.s.db, actor.organisationId, (tx) =>
              tx.patientRecord.findUnique({ where: { id }, select: { fileKey: true } }),
            )
          )?.fileKey === key;
      } catch {
        keep = true;
        request.log.warn({ recordId: id }, 'Upload commit uncertain; file retained for cleanup');
      }
      throw error;
    } finally {
      if (!keep)
        await this.s.files
          .delete(key)
          .catch(() =>
            request.log.warn({ recordId: id }, 'Uncommitted record file cleanup failed'),
          );
    }
  }
  async photos(request: FastifyRequest, actor: Actor, id: string, body: RecordPhotoPages) {
    // Authorize before decoding or allocating PDF work.
    const settings = await withTenant(this.s.db, actor.organisationId, async (tx) => {
      await this.owner(tx, actor, id);
      return readSettings(tx, actor.organisationId);
    });
    const sourceHash = hash(JSON.stringify(body));
    const ready = await withTenant(this.s.db, actor.organisationId, async (tx) => {
      const r = await this.owner(tx, actor, id);
      return r.state === 'ready' ? r : null;
    });
    if (ready)
      return this.upload(
        request,
        actor,
        id,
        { mediaType: 'application/pdf', data: Buffer.alloc(0) },
        sourceHash,
      );
    if (buildingPhotoPdfs.has(actor.organisationId) || buildingPhotoPdfs.size >= 2)
      throw new AppError(503, 'UNAVAILABLE', 'Photo checking is busy. Retry this upload shortly.', {
        file: 'busy',
      });
    buildingPhotoPdfs.add(actor.organisationId);
    try {
      if (!settings.uploadTypes.includes('pdf'))
        throw conflict('This clinic does not accept PDF uploads.');
      const inputs = body.pages.map((p) => ({
        mediaType: p.mediaType,
        data: Buffer.from(p.data, 'base64'),
      }));
      if (
        inputs.some((p, i) => p.data.toString('base64') !== body.pages[i]!.data) ||
        inputs.reduce((sum, p) => sum + p.data.length, 0) >
          Math.min(settings.maxUploadMb, 10) * 1048576
      )
        throw new AppError(400, 'VALIDATION_FAILED', 'Photo pages exceed the upload limit.');
      let pixels = 0;
      const doc = await PDFDocument.create();
      for (const p of inputs) {
        const image = inspectImage(p.data, { maxDimension: 4096, maxPixels: 4000000 });
        if (typeof image === 'string' || image.type !== 'jpeg' || p.mediaType !== 'image/jpeg')
          throw new AppError(400, 'VALIDATION_FAILED', 'Choose valid flattened JPEG photo pages.');
        pixels += image.width * image.height;
        if (pixels > 20000000)
          throw new AppError(400, 'VALIDATION_FAILED', 'Photo pages exceed the image limit.');
        // pdf-lib reads the underlying ArrayBuffer without respecting Buffer.byteOffset.
        // Give it an owned byte array, not a pooled Node Buffer.
        const embedded = await doc.embedJpg(new Uint8Array(p.data)).catch(() => {
            throw new AppError(
              400,
              'VALIDATION_FAILED',
              'The photo could not be read. Export it again as JPEG.',
            );
          }),
          page = doc.addPage([595, 842]);
        const scale = Math.min(555 / image.width, 802 / image.height);
        page.drawImage(embedded, {
          x: (595 - image.width * scale) / 2,
          y: (842 - image.height * scale) / 2,
          width: image.width * scale,
          height: image.height * scale,
        });
      }
      return this.upload(
        request,
        actor,
        id,
        { mediaType: 'application/pdf', data: Buffer.from(await doc.save()) },
        sourceHash,
      );
    } finally {
      buildingPhotoPdfs.delete(actor.organisationId);
    }
  }
  async list(
    request: FastifyRequest,
    actor: Actor,
    query: PatientRecordQuery,
    doctorPatientId?: string,
  ) {
    return withTenant(this.s.db, actor.organisationId, async (tx) => {
      let ids: string[];
      if (doctorPatientId) {
        if (
          actor.role !== 'doctor' ||
          !(await tx.membership.count({
            where: { userId: actor.userId, role: 'doctor', status: 'active' },
          }))
        )
          throw missing();
        const p = await tx.patient.findUnique({ where: { id: doctorPatientId } });
        if (!p) throw missing();
        ids = await historyIds(tx, liveId(p));
      } else {
        await new PortalService(this.s).requireConsents(tx, actor);
        const phone = await accountPhone(this.s, actor.userId);
        if (query.patientId) await ownPatient(tx, phone, query.patientId);
        const rows = await tx.patient.findMany({
          where: accountHistoryWhere(phone),
          select: { id: true, mergedIntoId: true },
        });
        ids = rows
          .filter(
            (p) =>
              !query.patientId || p.id === query.patientId || p.mergedIntoId === query.patientId,
          )
          .map((p) => p.id);
      }
      const where: Prisma.PatientRecordWhereInput = {
        patientId: { in: ids },
        ...(query.category ? { category: query.category } : {}),
        ...(doctorPatientId
          ? {
              state: 'ready',
              OR: [
                {
                  hiddenAt: null,
                  shares: {
                    some: {
                      doctorUserId: actor.userId,
                      revokedAt: null,
                      expiresAt: { gt: this.s.now() },
                    },
                  },
                },
                { uses: { some: { doctorUserId: actor.userId } } },
              ],
            }
          : { hiddenAt: query.hidden === 'true' ? { not: null } : null }),
      };
      if (
        query.cursor &&
        !(await tx.patientRecord.count({ where: { AND: [where, { id: query.cursor }] } }))
      )
        throw missing();
      const rows = await tx.patientRecord.findMany({
        where,
        orderBy: [...order],
        take: query.limit + 1,
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      });
      const rawPage = rows.slice(0, query.limit);
      let page = rawPage;
      if (doctorPatientId) {
        const recordIds = rawPage.map((r) => r.id);
        const used = await tx.patientRecordUse.findMany({
          where: { recordId: { in: recordIds }, doctorUserId: actor.userId },
          select: { recordId: true },
        });
        const shares = await tx.patientRecordShare.findMany({
          where: {
            recordId: { in: recordIds },
            doctorUserId: actor.userId,
            revokedAt: null,
            expiresAt: { gt: this.s.now() },
          },
          select: { recordId: true, createdByUserId: true },
        });
        const valid = await this.grantors(
          tx,
          shares.map((s) => s.createdByUserId),
        );
        const care = new Set(used.map((u) => u.recordId)),
          active = new Set(
            shares.filter((s) => valid.has(s.createdByUserId)).map((s) => s.recordId),
          );
        page = rawPage.filter((r) => care.has(r.id) || (!r.hiddenAt && active.has(r.id)));
      }
      const patients = await tx.patient.findMany({
        where: { id: { in: page.map((r) => r.patientId) } },
        select: patientSelect,
      });
      const names = await staffNames(
        this.s.db,
        page.map((r) => r.reviewedByUserId).filter((id): id is string => !!id),
      );
      const context: Names = { patients: new Map(patients.map((p) => [p.id, p])), names };
      const data: PatientRecord[] = [];
      for (const row of page) data.push(await this.out(tx, row, context, !doctorPatientId));
      await this.audit(tx, request, actor, null, 'record.list_viewed');
      return { data, nextCursor: rows.length > query.limit ? rawPage.at(-1)!.id : null };
    });
  }
  async view(request: FastifyRequest, actor: Actor, id: string, doctor = false) {
    return withTenant(this.s.db, actor.organisationId, async (tx) => {
      const r = doctor
        ? await tx.patientRecord.findUnique({ where: { id } })
        : await this.owner(tx, actor, id);
      if (!r) throw missing();
      if (doctor) await this.doctor(tx, actor, r);
      await this.audit(tx, request, actor, id, 'record.viewed');
      return this.out(tx, r, undefined, !doctor);
    });
  }
  async file(request: FastifyRequest, actor: Actor, id: string, doctor = false) {
    return withTenant(this.s.db, actor.organisationId, async (tx) => {
      await this.lock(tx, id);
      const r = doctor
        ? await tx.patientRecord.findUnique({ where: { id } })
        : await this.owner(tx, actor, id);
      if (!r) throw missing();
      if (doctor) await this.doctor(tx, actor, r);
      else if (r.hiddenAt) throw missing();
      if (r.state !== 'ready' || !r.fileKey || !r.mediaType) throw missing();
      const data = await this.s.files.get(r.fileKey);
      if (hash(data) !== r.sha256)
        throw new AppError(
          503,
          'UNAVAILABLE',
          'The file could not be verified. Please contact the clinic.',
        );
      await this.audit(tx, request, actor, id, 'record.file_opened');
      return { data, mediaType: r.mediaType };
    });
  }
  async update(request: FastifyRequest, actor: Actor, id: string, body: UpdatePatientRecord) {
    return withTenant(this.s.db, actor.organisationId, async (tx) => {
      await this.lock(tx, id);
      const r = await this.owner(tx, actor, id);
      if (r.hiddenAt || r.usedAt || !['ready', 'awaiting_upload'].includes(r.state))
        throw conflict('A record used in care cannot be changed.');
      if (r.revision !== body.revision)
        throw conflict('This record changed. Reload it before saving.');
      const p = await tx.patient.findUniqueOrThrow({ where: { id: r.patientId } });
      await this.links(tx, liveId(p), body.appointmentId, body.testOrderId);
      const updated = await tx.patientRecord.update({
        where: { id },
        data: {
          detailsCipher: this.s.cipher.encrypt(
            JSON.stringify({ title: body.title, note: body.note }),
          ),
          category: body.category,
          recordDate: body.recordDate ? new Date(body.recordDate) : null,
          appointmentId: body.appointmentId,
          testOrderId: body.testOrderId,
          revision: { increment: 1 },
          reviewedAt: null,
          reviewedByUserId: null,
        },
      });
      await this.audit(tx, request, actor, id, 'record.updated');
      return this.out(tx, updated);
    });
  }
  async hide(request: FastifyRequest, actor: Actor, id: string, restore = false) {
    return withTenant(this.s.db, actor.organisationId, async (tx) => {
      await this.lock(tx, id);
      const r = await this.owner(tx, actor, id);
      if (restore) {
        if (!r.usedAt || r.state !== 'ready')
          throw conflict('A deleted record cannot be restored.');
        const row = await tx.patientRecord.update({ where: { id }, data: { hiddenAt: null } });
        await this.audit(tx, request, actor, id, 'record.restored');
        return this.out(tx, row);
      }
      if (r.hiddenAt) return this.out(tx, r);
      await tx.patientRecordShare.updateMany({
        where: { recordId: id, revokedAt: null },
        data: { revokedAt: this.s.now(), tokenCipher: null },
      });
      const row = await tx.patientRecord.update({
        where: { id },
        data: {
          hiddenAt: this.s.now(),
          ...(r.usedAt ? {} : { state: 'deleting', purgeNextAt: this.s.now() }),
        },
      });
      await this.audit(
        tx,
        request,
        actor,
        id,
        r.usedAt ? 'record.hidden_retained' : 'record.deletion_requested',
      );
      return this.out(tx, row);
    });
  }
  async shares(actor: Actor, id: string) {
    return withTenant(this.s.db, actor.organisationId, async (tx) => {
      await this.owner(tx, actor, id);
      const rows = await tx.patientRecordShare.findMany({
        where: { recordId: id },
        orderBy: { createdAt: 'desc' },
        take: 100,
      });
      const data: RecordShare[] = [];
      for (const row of rows) data.push(await this.shareOut(row));
      return { data };
    });
  }
  async share(request: FastifyRequest, actor: Actor, id: string, body: CreateRecordShare) {
    return withTenant(this.s.db, actor.organisationId, async (tx) => {
      await this.lock(tx, id);
      const r = await this.owner(tx, actor, id);
      if (r.state !== 'ready' || r.hiddenAt) throw missing();
      const prior = await tx.patientRecordShare.findUnique({ where: { id: body.id } });
      if (prior) {
        if (
          prior.recordId !== id ||
          prior.doctorUserId !== body.doctorUserId ||
          prior.ttlHours !== body.ttlHours
        )
          throw conflict('This share request was already used.');
        return this.shareOut(prior);
      }
      if (
        !(await tx.membership.count({
          where: { userId: body.doctorUserId, role: 'doctor', status: 'active' },
        }))
      )
        throw missing();
      if (
        (await tx.patientRecordShare.count({
          where: { recordId: id, revokedAt: null, expiresAt: { gt: this.s.now() } },
        })) >= 10
      )
        throw conflict('Revoke an active share before creating another.');
      const token = randomBytes(32).toString('base64url');
      const row = await tx.patientRecordShare.create({
        data: {
          id: body.id,
          organisationId: actor.organisationId,
          recordId: id,
          doctorUserId: body.doctorUserId,
          createdByUserId: actor.userId,
          tokenHash: hash(token),
          tokenCipher: this.s.cipher.encrypt(token),
          ttlHours: body.ttlHours,
          createdAt: this.s.now(),
          expiresAt: new Date(this.s.now().getTime() + body.ttlHours * 3600000),
        },
      });
      await this.audit(tx, request, actor, id, 'record.shared');
      return this.shareOut(row);
    });
  }
  async revoke(request: FastifyRequest, actor: Actor, id: string, shareId: string) {
    return withTenant(this.s.db, actor.organisationId, async (tx) => {
      await this.lock(tx, id);
      await this.owner(tx, actor, id);
      const s = await tx.patientRecordShare.findFirst({ where: { id: shareId, recordId: id } });
      if (!s) throw missing();
      if (!s.revokedAt)
        await tx.patientRecordShare.update({
          where: { id: shareId },
          data: { revokedAt: this.s.now(), tokenCipher: null },
        });
      await this.audit(tx, request, actor, id, 'record.share_revoked');
      return { revoked: true };
    });
  }
  async resolve(request: FastifyRequest, actor: Actor, token: string) {
    return withTenant(this.s.db, actor.organisationId, async (tx) => {
      const share = await tx.patientRecordShare.findUnique({ where: { tokenHash: hash(token) } });
      if (
        !share ||
        share.doctorUserId !== actor.userId ||
        share.revokedAt ||
        share.expiresAt <= this.s.now()
      )
        throw missing();
      const r = await tx.patientRecord.findUniqueOrThrow({ where: { id: share.recordId } });
      if (r.hiddenAt) throw missing();
      await this.doctor(tx, actor, r);
      await this.audit(tx, request, actor, r.id, 'record.share_opened');
      return this.out(tx, r, undefined, false);
    });
  }
  async review(
    request: FastifyRequest,
    actor: Actor,
    id: string,
    revision: number,
    appointmentId?: string,
  ) {
    return withTenant(this.s.db, actor.organisationId, async (tx) => {
      await this.lock(tx, id);
      const r = await tx.patientRecord.findUnique({ where: { id } });
      if (!r) throw missing();
      await this.doctor(tx, actor, r);
      if (r.revision !== revision)
        throw conflict('This record changed. Open the latest version before reviewing.');
      if (appointmentId) {
        await tx.$queryRaw`SELECT id FROM appointments WHERE id=${appointmentId}::uuid FOR SHARE`;
        const a = await tx.appointment.findUnique({ where: { id: appointmentId } }),
          p = await tx.patient.findUniqueOrThrow({ where: { id: r.patientId } }),
          ids = await historyIds(tx, liveId(p));
        if (
          !a ||
          !ids.includes(a.patientId) ||
          a.doctorUserId !== actor.userId ||
          !TREATED.includes(a.status)
        )
          throw conflict('Choose a visit where you are treating this patient.');
        await tx.patientRecordUse.createMany({
          data: {
            organisationId: actor.organisationId,
            recordId: id,
            appointmentId,
            doctorUserId: actor.userId,
            revision,
            usedAt: this.s.now(),
          },
          skipDuplicates: true,
        });
      }
      const updated = await tx.patientRecord.update({
        where: { id },
        data: { reviewedAt: this.s.now(), reviewedByUserId: actor.userId },
      });
      await this.audit(
        tx,
        request,
        actor,
        id,
        appointmentId ? 'record.used_in_visit' : 'record.reviewed',
        appointmentId ? { appointmentId, revision } : { revision },
      );
      return this.out(tx, updated, undefined, false);
    });
  }
  private async out(tx: Tx, r: Row, context?: Names, manage = true): Promise<PatientRecord> {
    const p =
      context?.patients.get(r.patientId) ??
      (await tx.patient.findUniqueOrThrow({ where: { id: r.patientId }, select: patientSelect }));
    const details = r.detailsCipher
      ? RecordDetails.parse(JSON.parse(this.s.cipher.decrypt(r.detailsCipher)))
      : null;
    const names =
      context?.names ??
      (r.reviewedByUserId
        ? await staffNames(this.s.db, [r.reviewedByUserId])
        : new Map<string, string | null>());
    return RecordContract.parse({
      id: r.id,
      patient: p.mergedInto ?? p,
      title: details?.title ?? null,
      note: details?.note ?? null,
      category: r.category,
      recordDate: r.recordDate?.toISOString().slice(0, 10) ?? null,
      appointmentId: r.appointmentId,
      testOrderId: r.testOrderId,
      revision: r.revision,
      state: r.state,
      mediaType: r.mediaType,
      sizeBytes: r.sizeBytes,
      createdAt: r.createdAt.toISOString(),
      reviewedAt: r.reviewedAt?.toISOString() ?? null,
      reviewedByName: r.reviewedByUserId ? (names.get(r.reviewedByUserId) ?? null) : null,
      usedAt: r.usedAt?.toISOString() ?? null,
      hiddenAt: r.hiddenAt?.toISOString() ?? null,
      canEdit: manage && !r.usedAt && !r.hiddenAt && ['ready', 'awaiting_upload'].includes(r.state),
      canDelete: manage && !r.hiddenAt && ['ready', 'awaiting_upload'].includes(r.state),
      canRestore: manage && !!r.usedAt && !!r.hiddenAt && r.state === 'ready',
    });
  }
  private async shareOut(r: Prisma.PatientRecordShareGetPayload<object>): Promise<RecordShare> {
    const names = await staffNames(this.s.db, [r.doctorUserId]);
    return {
      id: r.id,
      doctorUserId: r.doctorUserId,
      doctorName: names.get(r.doctorUserId) ?? null,
      createdAt: r.createdAt.toISOString(),
      expiresAt: r.expiresAt.toISOString(),
      revokedAt: r.revokedAt?.toISOString() ?? null,
      url:
        !r.revokedAt && r.expiresAt > this.s.now() && r.tokenCipher
          ? `${this.s.webBaseUrl}/clinic/record-share#${this.s.cipher.decrypt(r.tokenCipher)}`
          : null,
    };
  }
  private audit(
    tx: Tx,
    request: FastifyRequest,
    actor: Actor,
    id: string | null,
    action: string,
    metadata: Record<string, unknown> = {},
  ) {
    return writeAudit(tx, request, {
      action,
      organisationId: actor.organisationId,
      actorUserId: actor.userId,
      entityType: 'patient_record',
      ...(id ? { entityId: id } : {}),
      metadata: metadata as Prisma.InputJsonObject,
    });
  }
}
