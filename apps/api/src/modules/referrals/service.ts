import type {
  CloseReferralBody,
  CreateReferralBody,
  Referral,
  ReferralCounts,
  ReferralListQuery,
  ReferralSummary,
  Role,
} from '@dhc/contracts';
import { withAuth, withTenant, type Prisma, type Tx } from '@dhc/db';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../../errors';
import type { Services } from '../../services';
import { writeAudit } from '../audit/write';
import { OPEN_REFERRAL } from '../clinical/access';
import { lockVisit, NOTE_STATUSES } from '../clinical/service';
import { assertNotMerged } from '../patients/merged';
import { staffNames } from '../prescribing/shared';

export interface Actor {
  userId: string;
  organisationId: string;
  role: Role;
}

const NOT_FOUND = () => new AppError(404, 'NOT_FOUND', 'Not found.');
const fromDbDate = (date: Date) => date.toISOString().slice(0, 10);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const referralInclude = {
  patient: {
    select: {
      id: true,
      name: true,
      uhid: true,
      mergedInto: { select: { id: true, name: true, uhid: true } },
    },
  },
  appointment: { select: { date: true } },
} as const;
type ReferralRow = Prisma.ReferralGetPayload<{ include: typeof referralInclude }>;

/** Newest first; the ID breaks ties so a cursor always names one place. */
const listOrder = [{ sentAt: 'desc' }, { id: 'asc' }] as const;

/** The opaque cursor is the last referral's ID (Prisma resumes from that row's sort values). */
export const encodeReferralCursor = (id: string) => Buffer.from(id).toString('base64url');
export function decodeReferralCursor(cursor: string): string {
  const id = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!UUID.test(id)) {
    throw new AppError(400, 'VALIDATION_FAILED', 'Invalid cursor.', { cursor: 'invalid' });
  }
  return id;
}

/** The referrals a doctor is a party to: the one who sent it or the one who received it. */
const partyOf = (userId: string) => ({
  OR: [{ referringDoctorUserId: userId }, { receivingDoctorUserId: userId }],
});

/**
 * Referrals (PRD §7.2), slice 1: the visit's doctor refers the patient to another doctor
 * of the organisation or outside it; the receiving doctor's opening it marks it seen; either
 * doctor closes it. Only the two doctors read a referral (anyone else gets 404), and only
 * doctors reach these routes: referrals carry clinical content, which the front desk and
 * clinic admins do not see (PRD §3.2). An internal referral that is not closed opens the
 * patient's chart to the receiving doctor (`assertChartAccess`). Audited without patient
 * data or the clinical text.
 */
export class ReferralService {
  constructor(private readonly s: Services) {}

  async create(
    request: FastifyRequest,
    actor: Actor,
    appointmentId: string,
    body: CreateReferralBody,
  ): Promise<Referral> {
    if (body.kind === 'internal') {
      if (body.receivingDoctorUserId === actor.userId) {
        throw new AppError(400, 'VALIDATION_FAILED', 'Refer the patient to another doctor.', {
          receivingDoctorUserId: 'self',
        });
      }
      // Users are platform-level: an account that was disabled cannot receive referrals.
      const active = await withAuth(this.s.db, (tx) =>
        tx.user.count({ where: { id: body.receivingDoctorUserId, status: 'active' } }),
      );
      if (active === 0) throw this.unknownDoctor();
    }
    const row = await withTenant(this.s.db, actor.organisationId, async (tx) => {
      const appointment = await lockVisit(tx, appointmentId);
      if (appointment.doctorUserId !== actor.userId) {
        throw new AppError(403, 'FORBIDDEN', 'Only the visit’s doctor can refer from it.');
      }
      if (!NOTE_STATUSES.includes(appointment.status)) {
        throw new AppError(
          409,
          'CONFLICT',
          'A referral can be made once the patient has checked in.',
          { status: appointment.status },
        );
      }
      const patient = await tx.patient.findUniqueOrThrow({
        where: { id: appointment.patientId },
        select: { mergedIntoId: true },
      });
      assertNotMerged(patient);
      if (body.kind === 'internal') {
        const member = await tx.membership.count({
          where: { userId: body.receivingDoctorUserId, role: 'doctor', status: 'active' },
        });
        if (member === 0) throw this.unknownDoctor();
      }
      const created = await tx.referral.create({
        data: {
          organisationId: actor.organisationId,
          appointmentId,
          patientId: appointment.patientId,
          referringDoctorUserId: actor.userId,
          kind: body.kind,
          ...(body.kind === 'internal'
            ? { receivingDoctorUserId: body.receivingDoctorUserId }
            : {
                externalName: body.external.name,
                externalSpecialty: body.external.specialty,
                externalHospital: body.external.hospital,
                externalPhone: body.external.phone,
              }),
          reason: body.reason,
          urgency: body.urgency,
          notes: body.notes,
          sentAt: this.s.now(),
        },
        include: referralInclude,
      });
      await this.audit(tx, request, actor, 'referral.created', created.id, {
        appointmentId,
        kind: created.kind,
        urgency: created.urgency,
        ...(created.receivingDoctorUserId
          ? { receivingDoctorUserId: created.receivingDoctorUserId }
          : {}),
      });
      return created;
    });
    return (await this.out([row], actor))[0]!;
  }

  /** The referrals made at a visit that the signed-in doctor sent or received. */
  async forVisit(request: FastifyRequest, actor: Actor, appointmentId: string) {
    const rows = await withTenant(this.s.db, actor.organisationId, async (tx) => {
      const visit = await tx.appointment.count({ where: { id: appointmentId } });
      if (visit === 0) throw NOT_FOUND();
      const found = await tx.referral.findMany({
        where: { appointmentId, ...partyOf(actor.userId) },
        include: referralInclude,
        orderBy: [...listOrder],
      });
      if (found.length > 0) {
        await writeAudit(tx, request, {
          action: 'referral.visit_viewed',
          organisationId: actor.organisationId,
          actorUserId: actor.userId,
          entityType: 'appointment',
          entityId: appointmentId,
          metadata: { count: found.length },
        });
      }
      return found;
    });
    return { data: await this.out(rows, actor) };
  }

  /**
   * Received (to the signed-in doctor) or sent (by them), newest first, a page at a time.
   * A summary holds no clinical text (no reason, notes or closing note), but it does name
   * the patient (name and UHID), the urgency and the outside recipient (name, specialty,
   * hospital, phone), so each request is audited as `referral.listed` with the box, the
   * count and whether it was a further page, never the rows themselves.
   */
  async list(
    request: FastifyRequest,
    actor: Actor,
    query: ReferralListQuery,
  ): Promise<{ data: ReferralSummary[]; nextCursor: string | null }> {
    const rows = await withTenant(this.s.db, actor.organisationId, async (tx) => {
      const found = await tx.referral.findMany({
        where: {
          ...(query.box === 'received'
            ? { receivingDoctorUserId: actor.userId }
            : { referringDoctorUserId: actor.userId }),
          ...(query.status ? { status: query.status } : {}),
        },
        include: referralInclude,
        orderBy: [...listOrder],
        take: query.limit + 1,
        ...(query.cursor ? { cursor: { id: decodeReferralCursor(query.cursor) }, skip: 1 } : {}),
      });
      await writeAudit(tx, request, {
        action: 'referral.listed',
        organisationId: actor.organisationId,
        actorUserId: actor.userId,
        entityType: 'user',
        entityId: actor.userId,
        metadata: {
          box: query.box,
          count: Math.min(found.length, query.limit),
          ...(query.cursor ? { page: 'next' } : {}),
        },
      });
      return found;
    });
    const page = rows.slice(0, query.limit);
    const out = await this.out(page, actor);
    return {
      data: out.map(summaryOf),
      nextCursor:
        rows.length > query.limit ? encodeReferralCursor(page[page.length - 1]!.id) : null,
    };
  }

  /** Three numbers for the dashboard; nothing about any patient, so not audited. */
  async counts(actor: Actor): Promise<ReferralCounts> {
    return withTenant(this.s.db, actor.organisationId, async (tx) => {
      const receivedNew = await tx.referral.count({
        where: { receivingDoctorUserId: actor.userId, status: 'sent' },
      });
      const receivedOpen = await tx.referral.count({
        where: { receivingDoctorUserId: actor.userId, status: { in: OPEN_REFERRAL } },
      });
      const sentOpen = await tx.referral.count({
        where: { referringDoctorUserId: actor.userId, status: { in: OPEN_REFERRAL } },
      });
      return { receivedNew, receivedOpen, sentOpen };
    });
  }

  /** One referral, for either of its doctors; every view is audited. */
  async get(request: FastifyRequest, actor: Actor, id: string): Promise<Referral> {
    const row = await withTenant(this.s.db, actor.organisationId, async (tx) => {
      const found = await this.find(tx, actor, id);
      await this.audit(tx, request, actor, 'referral.viewed', id);
      return found;
    });
    return (await this.out([row], actor))[0]!;
  }

  /**
   * The receiving doctor opened the referral: `sent` becomes `seen`. Opening it again, or
   * after it was closed, changes nothing (and is audited as a view).
   */
  async markSeen(request: FastifyRequest, actor: Actor, id: string): Promise<Referral> {
    const row = await withTenant(this.s.db, actor.organisationId, async (tx) => {
      const found = await this.lock(tx, actor, id);
      if (found.receivingDoctorUserId !== actor.userId) {
        throw new AppError(403, 'FORBIDDEN', 'Only the receiving doctor marks a referral seen.');
      }
      if (found.status !== 'sent') {
        await this.audit(tx, request, actor, 'referral.viewed', id);
        return found;
      }
      const seen = await tx.referral.update({
        where: { id },
        data: { status: 'seen', seenAt: this.s.now() },
        include: referralInclude,
      });
      await this.audit(tx, request, actor, 'referral.seen', id);
      return seen;
    });
    return (await this.out([row], actor))[0]!;
  }

  /** Either doctor closes the referral, with an optional note. Closing is final. */
  async close(
    request: FastifyRequest,
    actor: Actor,
    id: string,
    body: CloseReferralBody,
  ): Promise<Referral> {
    const row = await withTenant(this.s.db, actor.organisationId, async (tx) => {
      const found = await this.lock(tx, actor, id);
      if (found.status === 'closed') {
        throw new AppError(409, 'CONFLICT', 'This referral is already closed.', {
          status: 'closed',
        });
      }
      const closed = await tx.referral.update({
        where: { id },
        data: {
          status: 'closed',
          closedAt: this.s.now(),
          closedByUserId: actor.userId,
          closeNote: body.note,
        },
        include: referralInclude,
      });
      await this.audit(tx, request, actor, 'referral.closed', id, {
        by: found.referringDoctorUserId === actor.userId ? 'referring' : 'receiving',
        from: found.status,
        note: body.note !== null,
      });
      return closed;
    });
    return (await this.out([row], actor))[0]!;
  }

  // ---- Helpers ----------------------------------------------------------------------

  private unknownDoctor() {
    return new AppError(400, 'VALIDATION_FAILED', 'Choose an active doctor of this clinic.', {
      receivingDoctorUserId: 'invalid',
    });
  }

  /** The referral if the actor is one of its doctors; 404 otherwise, as for another clinic's. */
  private async find(tx: Tx, actor: Actor, id: string): Promise<ReferralRow> {
    const row = await tx.referral.findFirst({
      where: { id, ...partyOf(actor.userId) },
      include: referralInclude,
    });
    if (!row) throw NOT_FOUND();
    return row;
  }

  /** Row-locked, so a close and a mark-seen of one referral happen one after the other. */
  private async lock(tx: Tx, actor: Actor, id: string): Promise<ReferralRow> {
    await tx.$queryRaw`SELECT id FROM referrals WHERE id = ${id}::uuid FOR UPDATE`;
    return this.find(tx, actor, id);
  }

  private async out(rows: ReferralRow[], actor: Actor): Promise<Referral[]> {
    const names = await staffNames(
      this.s.db,
      rows.flatMap((r) => [
        r.referringDoctorUserId,
        ...(r.receivingDoctorUserId ? [r.receivingDoctorUserId] : []),
        ...(r.closedByUserId ? [r.closedByUserId] : []),
      ]),
    );
    const doctor = (userId: string) => ({ userId, name: names.get(userId) ?? null });
    return rows.map((r) => {
      const p = r.patient;
      return {
        id: r.id,
        kind: r.kind,
        status: r.status,
        urgency: r.urgency,
        patient: p.mergedInto ?? { id: p.id, name: p.name, uhid: p.uhid },
        referringDoctor: doctor(r.referringDoctorUserId),
        receivingDoctor: r.receivingDoctorUserId ? doctor(r.receivingDoctorUserId) : null,
        external:
          r.kind === 'external'
            ? {
                name: r.externalName!,
                specialty: r.externalSpecialty,
                hospital: r.externalHospital,
                phone: r.externalPhone,
              }
            : null,
        appointmentId: r.appointmentId,
        visitDate: fromDbDate(r.appointment.date),
        sentAt: r.sentAt.toISOString(),
        seenAt: r.seenAt?.toISOString() ?? null,
        closedAt: r.closedAt?.toISOString() ?? null,
        reason: r.reason,
        notes: r.notes,
        closedBy: r.closedByUserId ? doctor(r.closedByUserId) : null,
        closeNote: r.closeNote,
        role: r.referringDoctorUserId === actor.userId ? 'referring' : 'receiving',
        canClose: r.status !== 'closed',
      };
    });
  }

  private audit(
    tx: Tx,
    request: FastifyRequest,
    actor: Actor,
    action: string,
    referralId: string,
    metadata?: Prisma.InputJsonValue,
  ) {
    return writeAudit(tx, request, {
      action,
      organisationId: actor.organisationId,
      actorUserId: actor.userId,
      entityType: 'referral',
      entityId: referralId,
      metadata,
    });
  }
}

/** A list row: the referral without its clinical text. */
export function summaryOf(r: Referral): ReferralSummary {
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    urgency: r.urgency,
    patient: r.patient,
    referringDoctor: r.referringDoctor,
    receivingDoctor: r.receivingDoctor,
    external: r.external,
    appointmentId: r.appointmentId,
    visitDate: r.visitDate,
    sentAt: r.sentAt,
    seenAt: r.seenAt,
    closedAt: r.closedAt,
  };
}
