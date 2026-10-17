import type {
  AwaitingReviewList,
  PatientTestOrder,
  PortalTestOrder,
  Role,
  TestCatalogueItem,
  TestOrder,
} from '@dhc/contracts';
import { withTenant, type Prisma, type Tx } from '@dhc/db';
import type { FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { AppError } from '../../errors';
import { uniqueSuffix } from '../../files';
import type { Services } from '../../services';
import { writeAudit } from '../audit/write';
import { assertChartAccess } from '../clinical/access';
import { historyIds, liveId } from '../patients/merged';
import { staffNames } from '../prescribing/shared';
import { readSettings } from '../settings/service';
import { orderInclude, orderOut, type OrderRow } from './lines';
import { acceptUpload, type UploadedFile } from './upload';

export interface Actor {
  userId: string;
  organisationId: string;
  role: Role;
}

/**
 * For the patient portal: checks, inside the transaction, that the order's patient is one
 * of the account's (or a record merged into one), and throws 404 otherwise.
 */
export type PatientCheck = (tx: Tx, patientId: string) => Promise<unknown>;

const NOT_FOUND = () => new AppError(404, 'NOT_FOUND', 'Not found.');
const fromDbDate = (date: Date) => date.toISOString().slice(0, 10);
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

const visitSelect = { select: { date: true, doctorUserId: true } } as const;
type ListedRow = Prisma.TestOrderGetPayload<{
  include: typeof orderInclude & { appointment: typeof visitSelect };
}>;

/**
 * Test orders after signing (PRD §7.1): the catalogue, a patient's ordered tests, results
 * uploaded by the front desk, the doctor or the patient (stored by key, within the clinic's
 * upload limits), the doctor's review, and the doctor's list of results waiting for review
 * (the in-app notification; there is no push sender yet). Drafts are written with the
 * prescription (`lines.ts`). Doctors follow the chart model for anyone else's patients; the
 * front desk uploads and sees the list without the doctor's notes or the files.
 */
export class OrdersService {
  constructor(private readonly s: Services) {}

  async catalogue(actor: Actor, q?: string): Promise<TestCatalogueItem[]> {
    const rows = await withTenant(this.s.db, actor.organisationId, (tx) =>
      tx.testCatalogueItem.findMany({
        where: { active: true, ...(q ? { name: { contains: q, mode: 'insensitive' } } : {}) },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      }),
    );
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      name: r.name,
      regions: r.regions,
      views: r.views,
    }));
  }

  /** The patient's ordered tests, newest visit first (drafts stay on the consultation). */
  async forPatient(
    request: FastifyRequest,
    actor: Actor,
    patientId: string,
  ): Promise<PatientTestOrder[]> {
    const rows = await withTenant(this.s.db, actor.organisationId, async (tx) => {
      const patient = await tx.patient.findUnique({
        where: { id: patientId },
        select: { id: true, mergedIntoId: true },
      });
      if (!patient) throw NOT_FOUND();
      await assertChartAccess(tx, actor, liveId(patient));
      // A merged duplicate's orders show under the record that was kept.
      const ids = await historyIds(tx, liveId(patient));
      const rows: ListedRow[] = await tx.testOrder.findMany({
        where: { patientId: { in: ids }, orderedAt: { not: null } },
        include: { ...orderInclude, appointment: visitSelect },
        orderBy: [{ orderedAt: 'desc' }, { sortOrder: 'asc' }],
        take: 200,
      });
      await writeAudit(tx, request, {
        action: 'test_orders.viewed',
        organisationId: actor.organisationId,
        actorUserId: actor.userId,
        entityType: 'patient',
        entityId: patientId,
        metadata: { count: rows.length },
      });
      return rows;
    });
    const names = await staffNames(this.s.db, [
      ...rows.map((r) => r.doctorUserId),
      ...rows.flatMap((r) => (r.reviewedByUserId ? [r.reviewedByUserId] : [])),
    ]);
    return rows.map((r) => ({
      ...orderOut(r, { notes: actor.role === 'doctor' }),
      appointmentId: r.appointmentId,
      visitDate: fromDbDate(r.appointment.date),
      doctorName: names.get(r.doctorUserId) ?? null,
      reviewedByName: r.reviewedByUserId ? (names.get(r.reviewedByUserId) ?? null) : null,
      canReview: actor.role === 'doctor' && r.status === 'result_uploaded',
    }));
  }

  /**
   * The signed-in doctor's orders whose results wait for review, oldest result first. A
   * worklist like the queue: names and tests only, so not audited per view.
   */
  async awaitingReview(actor: Actor): Promise<AwaitingReviewList> {
    return withTenant(this.s.db, actor.organisationId, async (tx) => {
      const where = { doctorUserId: actor.userId, status: 'result_uploaded' as const };
      const count = await tx.testOrder.count({ where });
      const rows = await tx.testOrder.findMany({
        where,
        include: {
          appointment: {
            select: {
              date: true,
              patient: {
                select: {
                  id: true,
                  name: true,
                  uhid: true,
                  mergedInto: { select: { id: true, name: true, uhid: true } },
                },
              },
            },
          },
        },
        orderBy: [{ resultUploadedAt: 'asc' }, { id: 'asc' }],
        take: 50,
      });
      return {
        count,
        data: rows.map((r) => {
          const p = r.appointment.patient;
          return {
            id: r.id,
            kind: r.kind,
            name: r.name,
            region: r.region,
            side: r.side,
            views: r.views,
            resultUploadedAt: r.resultUploadedAt!.toISOString(),
            visitDate: fromDbDate(r.appointment.date),
            patient: p.mergedInto ?? { id: p.id, name: p.name, uhid: p.uhid },
          };
        }),
      };
    });
  }

  /**
   * Stores a result against an ordered test and moves it to `result_uploaded` (again, if a
   * doctor had reviewed an earlier one). Staff: front desk or a doctor with the chart; the
   * portal passes `allowPatient`.
   */
  async upload(
    request: FastifyRequest,
    actor: Actor,
    orderId: string,
    file: UploadedFile,
    allowPatient?: PatientCheck,
  ): Promise<TestOrder> {
    // The file is written before the rows that point at it. If the transaction then fails
    // (or its commit does), the file is removed again so nothing is left without a record.
    let stored: string | null = null;
    try {
      return await this.storeResult(request, actor, orderId, file, allowPatient, (key) => {
        stored = key;
      });
    } catch (error) {
      if (stored) {
        const key: string = stored;
        await this.s.files
          .delete(key)
          .catch((err: unknown) =>
            request.log.error({ err, key }, 'Could not remove the file of a failed result upload'),
          );
      }
      throw error;
    }
  }

  private storeResult(
    request: FastifyRequest,
    actor: Actor,
    orderId: string,
    file: UploadedFile,
    allowPatient: PatientCheck | undefined,
    onStored: (key: string) => void,
  ): Promise<TestOrder> {
    return withTenant(this.s.db, actor.organisationId, async (tx) => {
      const order = await this.lockOrder(tx, actor, orderId, allowPatient);
      if (!order.orderedAt) {
        throw new AppError(
          409,
          'CONFLICT',
          'Results can be added once the prescription ordering this test is signed.',
        );
      }
      const { extension } = acceptUpload(await readSettings(tx, actor.organisationId), file);
      const digest = sha256(file.data);
      // No patient data in the key (threat model T4): clinic, order and a random suffix.
      const key = `organisations/${actor.organisationId}/test-results/${order.id}-${uniqueSuffix()}.${extension}`;
      await this.s.files.put(key, file.data);
      onStored(key);
      const now = this.s.now();
      const result = await tx.testResult.create({
        data: {
          organisationId: actor.organisationId,
          testOrderId: order.id,
          fileKey: key,
          mediaType: file.mediaType,
          sizeBytes: file.data.length,
          sha256: digest,
          uploadedByUserId: actor.userId,
          uploadedByRole: actor.role,
          uploadedAt: now,
        },
      });
      await tx.testOrder.update({
        where: { id: order.id },
        data: {
          status: 'result_uploaded',
          resultUploadedAt: now,
          reviewedAt: null,
          reviewedByUserId: null,
        },
      });
      await this.audit(tx, request, actor, 'test_order.result_uploaded', order.id, {
        resultId: result.id,
        mediaType: file.mediaType,
        sizeBytes: file.data.length,
        sha256: digest,
        by: actor.role,
        ...(order.status === 'reviewed' ? { reopened: true } : {}),
      });
      return orderOut(await this.reload(tx, order.id), { notes: actor.role !== 'front_desk' });
    });
  }

  /** A doctor marks the uploaded result reviewed (PRD §7.1). */
  async review(request: FastifyRequest, actor: Actor, orderId: string): Promise<TestOrder> {
    return withTenant(this.s.db, actor.organisationId, async (tx) => {
      const order = await this.lockOrder(tx, actor, orderId);
      if (order.status !== 'result_uploaded') {
        throw new AppError(
          409,
          'CONFLICT',
          order.status === 'reviewed'
            ? 'This result is already reviewed.'
            : 'There is no result to review yet.',
          { status: order.status },
        );
      }
      await tx.testOrder.update({
        where: { id: order.id },
        data: { status: 'reviewed', reviewedAt: this.s.now(), reviewedByUserId: actor.userId },
      });
      await this.audit(tx, request, actor, 'test_order.reviewed', order.id, {
        results: order.results.length,
      });
      return orderOut(await this.reload(tx, order.id));
    });
  }

  /**
   * One result's file, checked against its recorded hash. Doctors (the chart model applies)
   * and, through the portal, the patient; never the front desk.
   */
  async resultFile(
    request: FastifyRequest,
    actor: Actor,
    resultId: string,
    allowPatient?: PatientCheck,
  ): Promise<{ file: Buffer; mediaType: string; filename: string }> {
    return withTenant(this.s.db, actor.organisationId, async (tx) => {
      const result = await tx.testResult.findUnique({
        where: { id: resultId },
        include: { testOrder: { select: { id: true, patientId: true, doctorUserId: true } } },
      });
      if (!result) throw NOT_FOUND();
      await this.allowed(tx, actor, result.testOrder, allowPatient);
      const file = await this.s.files.get(result.fileKey);
      if (sha256(file) !== result.sha256) {
        throw new Error(`Stored result ${result.id} does not match its hash`);
      }
      await this.audit(tx, request, actor, 'test_result.viewed', result.testOrder.id, {
        resultId: result.id,
      });
      const extension = result.fileKey.slice(result.fileKey.lastIndexOf('.') + 1);
      return {
        file,
        mediaType: result.mediaType,
        filename: `result-${result.id.slice(0, 8)}.${extension}`,
      };
    });
  }

  /** The family's ordered tests for the Patient app, newest first; audited per view. */
  async forAccount(
    request: FastifyRequest,
    actor: Actor,
    patients: { id: string; name: string; mergedInto: { id: string; name: string } | null }[],
  ): Promise<PortalTestOrder[]> {
    const rows = await withTenant(this.s.db, actor.organisationId, async (tx) => {
      const rows = await tx.testOrder.findMany({
        where: { patientId: { in: patients.map((p) => p.id) }, orderedAt: { not: null } },
        include: { ...orderInclude, appointment: visitSelect },
        orderBy: [{ orderedAt: 'desc' }, { sortOrder: 'asc' }],
        take: 200,
      });
      await writeAudit(tx, request, {
        action: 'test_orders.viewed',
        organisationId: actor.organisationId,
        actorUserId: actor.userId,
        entityType: 'account',
        entityId: actor.userId,
        metadata: { count: rows.length, source: 'patient_app' },
      });
      return rows;
    });
    const patientOf = new Map(
      patients.map((p) => [p.id, p.mergedInto ?? { id: p.id, name: p.name }]),
    );
    const names = await staffNames(
      this.s.db,
      rows.map((r) => r.doctorUserId),
    );
    return rows.map((r) => {
      const out = orderOut(r);
      return {
        id: r.id,
        patient: patientOf.get(r.patientId)!,
        doctorName: names.get(r.doctorUserId) ?? null,
        visitDate: fromDbDate(r.appointment.date),
        kind: r.kind,
        name: r.name,
        region: r.region,
        side: r.side,
        views: r.views,
        notes: r.notes,
        status: r.status,
        orderedAt: out.orderedAt!,
        reviewedAt: out.reviewedAt,
        results: out.results,
      };
    });
  }

  // ---- Helpers ----------------------------------------------------------------------

  /** The order, row-locked so uploads and reviews of one order happen one at a time. */
  private async lockOrder(
    tx: Tx,
    actor: Actor,
    orderId: string,
    allowPatient?: PatientCheck,
  ): Promise<OrderRow> {
    await tx.$queryRaw`SELECT id FROM test_orders WHERE id = ${orderId}::uuid FOR UPDATE`;
    const order = await tx.testOrder.findUnique({ where: { id: orderId }, include: orderInclude });
    // Patients see only ordered tests; a draft line is not theirs to know about yet.
    if (!order || (allowPatient && !order.orderedAt)) throw NOT_FOUND();
    await this.allowed(tx, actor, order, allowPatient);
    return order;
  }

  private async allowed(
    tx: Tx,
    actor: Actor,
    order: { patientId: string; doctorUserId: string },
    allowPatient?: PatientCheck,
  ) {
    if (allowPatient) return void (await allowPatient(tx, order.patientId));
    if (actor.role === 'patient') throw NOT_FOUND();
    // A doctor's own order is always theirs; anyone else's follows the chart model.
    if (order.doctorUserId !== actor.userId) await assertChartAccess(tx, actor, order.patientId);
  }

  private reload(tx: Tx, id: string) {
    return tx.testOrder.findUniqueOrThrow({ where: { id }, include: orderInclude });
  }

  private audit(
    tx: Tx,
    request: FastifyRequest,
    actor: Actor,
    action: string,
    orderId: string,
    metadata?: Prisma.InputJsonValue,
  ) {
    return writeAudit(tx, request, {
      action,
      organisationId: actor.organisationId,
      actorUserId: actor.userId,
      entityType: 'test_order',
      entityId: orderId,
      metadata,
    });
  }
}
