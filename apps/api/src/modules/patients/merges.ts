import type {
  ApprovePatientMergeBody,
  CreatePatientMergeBody,
  PatientMergeQuery,
  PatientMergeRequest,
  RejectPatientMergeBody,
} from '@dhc/contracts';
import { withTenant, type Prisma, type Tx } from '@dhc/db';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../../errors';
import type { Services } from '../../services';
import { writeAudit } from '../audit/write';
import { staffNames } from '../prescribing/shared';
import { assertNotMerged } from './merged';

interface Actor {
  userId: string;
  organisationId: string;
}

const NOT_FOUND = () => new AppError(404, 'NOT_FOUND', 'Not found.');
const conflict = (merge: string, message: string) =>
  new AppError(409, 'CONFLICT', message, { merge });

const side = {
  select: {
    id: true,
    uhid: true,
    name: true,
    phone: true,
    dob: true,
    gender: true,
    createdAt: true,
    _count: { select: { appointments: { where: { status: 'completed' as const } } } },
  },
} as const;
const include = { source: side, target: side } as const;
type RequestRow = Prisma.PatientMergeRequestGetPayload<{ include: typeof include }>;

type MergePatient = {
  id: string;
  guardianPatientId: string | null;
  mergedIntoId: string | null;
};

/**
 * Merging duplicate patient records (PRD §3.2, §5.3). Anyone who registers patients may
 * ask; a clinic admin decides. Approving moves the living record (chart entries, tags,
 * upcoming bookings, dependants) to the kept record and closes the duplicate. Past
 * visits, prescriptions and bills stay where they were written, because signed records
 * never change; they show under the kept record from then on. Merges cannot be undone.
 */
export class PatientMergeService {
  constructor(private readonly s: Services) {}

  async request(
    request: FastifyRequest,
    actor: Actor,
    body: CreatePatientMergeBody,
  ): Promise<PatientMergeRequest> {
    if (body.sourcePatientId === body.targetPatientId) {
      throw new AppError(400, 'VALIDATION_FAILED', 'Choose two different records.', {
        targetPatientId: 'invalid',
      });
    }
    const row = await withTenant(this.s.db, actor.organisationId, async (tx) => {
      await this.lock(tx, actor);
      const { source, target } = await this.pair(tx, body.sourcePatientId, body.targetPatientId);
      const open = await tx.patientMergeRequest.count({
        where: {
          status: 'pending',
          OR: [source.id, target.id].flatMap((id) => [
            { sourcePatientId: id },
            { targetPatientId: id },
          ]),
        },
      });
      if (open > 0) {
        throw conflict(
          'pending',
          'One of these records already has a merge waiting for a decision.',
        );
      }
      await this.checkFamily(tx, source, target);
      const created = await tx.patientMergeRequest.create({
        data: {
          organisationId: actor.organisationId,
          sourcePatientId: source.id,
          targetPatientId: target.id,
          reason: body.reason,
          requestedByUserId: actor.userId,
        },
        include,
      });
      await this.audit(tx, request, actor, 'patient_merge.requested', created.id, {
        sourcePatientId: source.id,
        targetPatientId: target.id,
      });
      return created;
    });
    return (await this.out([row]))[0]!;
  }

  async list(actor: Actor, query: PatientMergeQuery): Promise<PatientMergeRequest[]> {
    const rows = await withTenant(this.s.db, actor.organisationId, (tx) =>
      query.status === 'pending'
        ? tx.patientMergeRequest.findMany({
            where: { status: 'pending' },
            include,
            orderBy: { requestedAt: 'asc' },
          })
        : tx.patientMergeRequest.findMany({
            where: { status: { not: 'pending' } },
            include,
            orderBy: { decidedAt: 'desc' },
            take: 50,
          }),
    );
    return this.out(rows);
  }

  async approve(
    request: FastifyRequest,
    actor: Actor,
    id: string,
    body: ApprovePatientMergeBody,
  ): Promise<PatientMergeRequest> {
    const row = await withTenant(this.s.db, actor.organisationId, async (tx) => {
      await this.lock(tx, actor);
      const pending = await this.pending(tx, id);
      const { source, target } = await this.pair(
        tx,
        pending.sourcePatientId,
        pending.targetPatientId,
      );
      await this.checkFamily(tx, source, target);
      const from = { patientId: source.id };
      const to = { patientId: target.id };

      // The living chart, including removed entries with who removed them and why.
      const allergies = await tx.allergy.updateMany({ where: from, data: to });
      const conditions = await tx.medicalCondition.updateMany({ where: from, data: to });
      const medications = await tx.currentMedication.updateMany({ where: from, data: to });

      // Tags the kept record lacks.
      const sourceTags = await tx.patientTag.findMany({ where: from });
      const targetTags = new Set(
        (await tx.patientTag.findMany({ where: to, select: { tagId: true } })).map((t) => t.tagId),
      );
      const newTags = sourceTags.filter((t) => !targetTags.has(t.tagId));
      if (newTags.length > 0) {
        await tx.patientTag.createMany({
          data: newTags.map((t) => ({ ...t, patientId: target.id })),
        });
      }
      await tx.patientTag.deleteMany({ where: from });

      // Upcoming bookings nobody has started on yet; visits under way or done stay put.
      const bookings = await tx.appointment.updateMany({
        where: {
          ...from,
          status: { in: ['pending', 'confirmed'] },
          vitals: { is: null },
          consultation: { is: null },
        },
        data: to,
      });

      // Family and earlier merges follow the duplicate.
      if (target.guardianPatientId === source.id) {
        await tx.patient.update({ where: { id: target.id }, data: { guardianPatientId: null } });
      }
      const dependants = await tx.patient.updateMany({
        where: { guardianPatientId: source.id, id: { not: target.id } },
        data: { guardianPatientId: target.id },
      });
      await tx.patient.updateMany({
        where: { mergedIntoId: source.id },
        data: { mergedIntoId: target.id },
      });

      // A patient-app account moves when the kept record has none.
      const accounts = await tx.patient.findMany({
        where: { id: { in: [source.id, target.id] } },
        select: { id: true, accountUserId: true },
      });
      const sourceAccount = accounts.find((a) => a.id === source.id)?.accountUserId ?? null;
      const targetAccount = accounts.find((a) => a.id === target.id)?.accountUserId ?? null;
      const moveAccount = sourceAccount !== null && targetAccount === null;
      if (moveAccount) {
        await tx.patient.update({ where: { id: source.id }, data: { accountUserId: null } });
        await tx.patient.update({
          where: { id: target.id },
          data: { accountUserId: sourceAccount },
        });
      }

      const now = this.s.now();
      await tx.patient.update({
        where: { id: source.id },
        data: { mergedIntoId: target.id, mergedAt: now },
      });
      const decided = await tx.patientMergeRequest.update({
        where: { id },
        data: {
          status: 'approved',
          decidedByUserId: actor.userId,
          decidedAt: now,
          decisionNote: body.note ?? null,
        },
        include,
      });
      await this.audit(tx, request, actor, 'patient.merged', id, {
        sourcePatientId: source.id,
        targetPatientId: target.id,
        moved: {
          allergies: allergies.count,
          conditions: conditions.count,
          medications: medications.count,
          tags: newTags.length,
          bookings: bookings.count,
          dependants: dependants.count,
          account: moveAccount,
        },
      });
      return decided;
    });
    return (await this.out([row]))[0]!;
  }

  async reject(
    request: FastifyRequest,
    actor: Actor,
    id: string,
    body: RejectPatientMergeBody,
  ): Promise<PatientMergeRequest> {
    const row = await withTenant(this.s.db, actor.organisationId, async (tx) => {
      await this.lock(tx, actor);
      await this.pending(tx, id);
      const decided = await tx.patientMergeRequest.update({
        where: { id },
        data: {
          status: 'rejected',
          decidedByUserId: actor.userId,
          decidedAt: this.s.now(),
          decisionNote: body.note,
        },
        include,
      });
      await this.audit(tx, request, actor, 'patient_merge.rejected', id, {
        sourcePatientId: decided.sourcePatientId,
        targetPatientId: decided.targetPatientId,
      });
      return decided;
    });
    return (await this.out([row]))[0]!;
  }

  // ---- Helpers ----------------------------------------------------------------------

  /** One merge at a time per clinic, so two decisions cannot cross. */
  private lock(tx: Tx, actor: Actor) {
    return tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`patient-merge:${actor.organisationId}`}))`;
  }

  private async pending(tx: Tx, id: string) {
    const row = await tx.patientMergeRequest.findUnique({ where: { id } });
    if (!row) throw NOT_FOUND();
    if (row.status !== 'pending') {
      throw conflict('decided', 'This merge request has already been decided.');
    }
    return row;
  }

  /** Both records, live; a merged one cannot take part in another merge. */
  private async pair(tx: Tx, sourceId: string, targetId: string) {
    const select = { id: true, guardianPatientId: true, mergedIntoId: true } as const;
    const source = await tx.patient.findUnique({ where: { id: sourceId }, select });
    const target = await tx.patient.findUnique({ where: { id: targetId }, select });
    if (!source) throw this.invalid('sourcePatientId');
    if (!target) throw this.invalid('targetPatientId');
    assertNotMerged(source);
    assertNotMerged(target);
    return { source, target };
  }

  private invalid(field: string) {
    return new AppError(400, 'VALIDATION_FAILED', 'Choose a registered patient.', {
      [field]: 'invalid',
    });
  }

  /**
   * Guardians are one level deep: the duplicate's dependants move to the kept record, so
   * the kept record must not have a guardian of its own (unless that guardian is the
   * duplicate, a link the merge removes).
   */
  private async checkFamily(tx: Tx, source: MergePatient, target: MergePatient) {
    if (!target.guardianPatientId || target.guardianPatientId === source.id) return;
    const dependants = await tx.patient.count({
      where: { guardianPatientId: source.id, id: { not: target.id } },
    });
    if (dependants > 0) {
      throw conflict(
        'guardian',
        'The duplicate is a guardian for others but the kept record has a guardian. Change the family links first.',
      );
    }
  }

  private audit(
    tx: Tx,
    request: FastifyRequest,
    actor: Actor,
    action: string,
    requestId: string,
    metadata: Prisma.InputJsonValue,
  ) {
    return writeAudit(tx, request, {
      action,
      organisationId: actor.organisationId,
      actorUserId: actor.userId,
      entityType: 'patient_merge_request',
      entityId: requestId,
      metadata,
    });
  }

  private async out(rows: RequestRow[]): Promise<PatientMergeRequest[]> {
    const names = await staffNames(
      this.s.db,
      rows.flatMap((r) => [r.requestedByUserId, ...(r.decidedByUserId ? [r.decidedByUserId] : [])]),
    );
    const sideOut = (p: RequestRow['source']) => ({
      id: p.id,
      uhid: p.uhid,
      name: p.name,
      phone: p.phone,
      dob: p.dob ? p.dob.toISOString().slice(0, 10) : null,
      gender: p.gender,
      registeredAt: p.createdAt.toISOString(),
      visits: p._count.appointments,
    });
    return rows.map((r) => ({
      id: r.id,
      source: sideOut(r.source),
      target: sideOut(r.target),
      reason: r.reason,
      status: r.status,
      requestedByName: names.get(r.requestedByUserId) ?? null,
      requestedAt: r.requestedAt.toISOString(),
      decidedByName: r.decidedByUserId ? (names.get(r.decidedByUserId) ?? null) : null,
      decidedAt: r.decidedAt?.toISOString() ?? null,
      decisionNote: r.decisionNote,
    }));
  }
}
