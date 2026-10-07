import {
  ACTIVE_APPOINTMENT_STATUSES,
  type Appointment,
  type AppointmentAction,
  type AppointmentActionBody,
  type AppointmentDetail,
  type AppointmentListQuery,
  type AppointmentSource,
  type AppointmentStatus,
  type CreateAppointmentBody,
  type RescheduleAppointmentBody,
  type Role,
} from '@dhc/contracts';
import { withAuth, withTenant, type Prisma, type Tx } from '@dhc/db';
import { istDate } from '@dhc/domain';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../../errors';
import type { Services } from '../../services';
import { writeAudit } from '../audit/write';
import { toSummary, withTags } from '../patients/service';
import { loadDaySlots } from '../scheduling/availability';

interface Actor {
  userId: string;
  organisationId: string;
  role: Role;
}

const NOT_FOUND = () => new AppError(404, 'NOT_FOUND', 'Not found.');
const FORBIDDEN = () => new AppError(403, 'FORBIDDEN', 'You do not have access to this.');
const invalid = (field: string, message: string) =>
  new AppError(400, 'VALIDATION_FAILED', message, { [field]: 'invalid' });

const toDbDate = (date: string) => new Date(`${date}T00:00:00.000Z`);
const fromDbDate = (date: Date) => date.toISOString().slice(0, 10);
const istTime = (instant: Date) =>
  new Date(instant.getTime() + 330 * 60_000).toISOString().slice(11, 16);

/** Statuses whose slot stays taken; completed visits count, so nobody is booked over them. */
const SLOT_HOLDING: AppointmentStatus[] = [...ACTIVE_APPOINTMENT_STATUSES, 'completed'];

const include = {
  patient: { include: withTags },
  clinic: { select: { name: true } },
  consultationType: { select: { name: true, mode: true } },
  rescheduledTo: { select: { id: true } },
} as const;
type AppointmentRow = Prisma.AppointmentGetPayload<{ include: typeof include }>;

/**
 * Status changes (PRD §5.2) and who may make them (PRD §3.2): front desk and doctors
 * check in and mark no-shows; the consultation itself is the doctor's.
 */
const ACTIONS: Record<
  AppointmentAction,
  { from: AppointmentStatus[]; to: AppointmentStatus; roles: Role[] }
> = {
  confirm: { from: ['pending'], to: 'confirmed', roles: ['front_desk', 'doctor', 'clinic_admin'] },
  check_in: { from: ['pending', 'confirmed'], to: 'checked_in', roles: ['front_desk', 'doctor'] },
  start: { from: ['checked_in'], to: 'in_consultation', roles: ['doctor'] },
  complete: { from: ['in_consultation'], to: 'completed', roles: ['doctor'] },
  cancel: {
    from: ['pending', 'confirmed', 'checked_in'],
    to: 'cancelled',
    roles: ['front_desk', 'doctor', 'clinic_admin'],
  },
  no_show: { from: ['pending', 'confirmed'], to: 'no_show', roles: ['front_desk', 'doctor'] },
};

interface Placement {
  patientId: string;
  doctorUserId: string;
  clinicId: string;
  consultationTypeId: string;
  startAt?: string;
  walkIn: boolean;
  overbook: boolean;
  reason?: string | null;
  source: AppointmentSource;
  rescheduledFromId?: string;
}

/**
 * Appointments (PRD §4.3, §5): booking into a slot, overbooking within the clinic's
 * daily limit, walk-ins, status changes with history, and rescheduling. Bookings for a
 * doctor's day are serialised with a transaction-scoped advisory lock, so two people
 * can never take the same slot.
 */
export class AppointmentService {
  constructor(private readonly s: Services) {}

  async list(actor: Actor, query: AppointmentListQuery): Promise<Appointment[]> {
    const rows = await withTenant(this.s.db, actor.organisationId, (tx) =>
      tx.appointment.findMany({
        where: {
          ...(query.patientId
            ? { patientId: query.patientId, ...(query.date ? { date: toDbDate(query.date) } : {}) }
            : { date: toDbDate(query.date ?? istDate(this.s.now())) }),
          doctorUserId: query.doctorId,
          clinicId: query.clinicId,
        },
        include,
        orderBy: query.patientId
          ? [{ startAt: 'desc' }]
          : [{ startAt: 'asc' }, { tokenNumber: 'asc' }],
        take: 500,
      }),
    );
    const names = await this.names(rows.map((r) => r.doctorUserId));
    return rows.map((r) => this.toAppointment(r, names));
  }

  async view(actor: Actor, id: string): Promise<AppointmentDetail> {
    return withTenant(this.s.db, actor.organisationId, (tx) => this.detail(tx, id));
  }

  async create(
    request: FastifyRequest,
    actor: Actor,
    body: CreateAppointmentBody,
  ): Promise<AppointmentDetail> {
    if (body.walkIn && body.startAt) {
      throw invalid('startAt', 'A walk-in joins today’s queue; leave the time empty.');
    }
    if (!body.walkIn && !body.startAt) throw invalid('startAt', 'Choose a slot.');
    return withTenant(this.s.db, actor.organisationId, async (tx) => {
      const id = await this.place(tx, request, actor, {
        ...body,
        source: body.walkIn ? 'walk_in' : 'front_desk',
      });
      return this.detail(tx, id);
    });
  }

  async act(
    request: FastifyRequest,
    actor: Actor,
    id: string,
    body: AppointmentActionBody,
  ): Promise<AppointmentDetail> {
    const rule = ACTIONS[body.action];
    if (!rule.roles.includes(actor.role)) throw FORBIDDEN();
    if (body.action === 'cancel' && !body.reason) {
      throw invalid('reason', 'Give a reason for cancelling.');
    }
    return withTenant(this.s.db, actor.organisationId, async (tx) => {
      const appointment = await this.lockRow(tx, id);
      if (!appointment) throw NOT_FOUND();
      if (!rule.from.includes(appointment.status)) {
        throw new AppError(
          409,
          'CONFLICT',
          `This appointment is ${appointment.status.replace('_', ' ')} and cannot be changed that way.`,
        );
      }
      const now = this.s.now();
      if (
        (body.action === 'start' || body.action === 'complete') &&
        appointment.doctorUserId !== actor.userId
      ) {
        throw new AppError(403, 'FORBIDDEN', 'Only the patient’s doctor can do this.');
      }
      if (body.action === 'check_in' && fromDbDate(appointment.date) !== istDate(now)) {
        throw new AppError(409, 'CONFLICT', 'Patients can only be checked in on the day.');
      }
      if (body.action === 'no_show' && appointment.startAt > now) {
        throw new AppError(409, 'CONFLICT', 'A no-show can only be marked after the slot starts.');
      }

      await tx.appointment.update({
        where: { id },
        data: {
          status: rule.to,
          ...(body.action === 'cancel' ? { cancelReason: body.reason } : {}),
          ...(body.action === 'check_in' ? { checkedInAt: now } : {}),
          ...(body.action === 'start' ? { consultationStartedAt: now } : {}),
          ...(body.action === 'complete' ? { completedAt: now } : {}),
        },
      });
      await this.record(tx, actor, id, appointment.status, rule.to, now, body.reason ?? null);
      await writeAudit(tx, request, {
        action: 'appointment.status_changed',
        organisationId: actor.organisationId,
        actorUserId: actor.userId,
        entityType: 'appointment',
        entityId: id,
        metadata: { from: appointment.status, to: rule.to },
      });
      return this.detail(tx, id);
    });
  }

  async reschedule(
    request: FastifyRequest,
    actor: Actor,
    id: string,
    body: RescheduleAppointmentBody,
  ): Promise<AppointmentDetail> {
    return withTenant(this.s.db, actor.organisationId, async (tx) => {
      const old = await this.lockRow(tx, id);
      if (!old) throw NOT_FOUND();
      if (!['pending', 'confirmed'].includes(old.status)) {
        throw new AppError(409, 'CONFLICT', 'Only booked appointments can be rescheduled.');
      }
      const newId = await this.place(tx, request, actor, {
        patientId: old.patientId,
        doctorUserId: body.doctorUserId ?? old.doctorUserId,
        clinicId: body.clinicId ?? old.clinicId,
        consultationTypeId: body.consultationTypeId ?? old.consultationTypeId,
        startAt: body.startAt,
        walkIn: false,
        overbook: body.overbook,
        reason: old.reason,
        source: old.source,
        rescheduledFromId: old.id,
      });
      const now = this.s.now();
      await tx.appointment.update({ where: { id }, data: { status: 'rescheduled' } });
      await this.record(tx, actor, id, old.status, 'rescheduled', now, null);
      await writeAudit(tx, request, {
        action: 'appointment.rescheduled',
        organisationId: actor.organisationId,
        actorUserId: actor.userId,
        entityType: 'appointment',
        entityId: id,
        metadata: { newAppointmentId: newId },
      });
      return this.detail(tx, newId);
    });
  }

  /** Checks and books one appointment inside the caller's transaction; returns its ID. */
  private async place(
    tx: Tx,
    request: FastifyRequest,
    actor: Actor,
    p: Placement,
  ): Promise<string> {
    const now = this.s.now();
    const patient = await tx.patient.findUnique({
      where: { id: p.patientId },
      select: { id: true },
    });
    if (!patient) throw invalid('patientId', 'Choose a registered patient.');
    const doctor = await tx.membership.findFirst({
      where: { userId: p.doctorUserId, role: 'doctor', status: 'active' },
      select: { id: true },
    });
    if (!doctor) throw invalid('doctorUserId', 'Choose an active doctor.');

    const date = p.walkIn ? istDate(now) : istDate(new Date(p.startAt!));
    // One booking at a time per doctor and day: slot checks and tokens stay consistent.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`appt:${p.doctorUserId}:${date}`}, 0))`;

    const loaded = await loadDaySlots(
      tx,
      actor.organisationId,
      {
        doctorId: p.doctorUserId,
        clinicId: p.clinicId,
        consultationTypeId: p.consultationTypeId,
        date,
        channel: 'staff',
      },
      now,
      { ignoreAppointmentId: p.rescheduledFromId },
    );
    if (!loaded) throw invalid('clinicId', 'Choose an active clinic and consultation type.');

    let startAt: Date;
    let endAt: Date;
    let overbook = false;
    if (p.walkIn) {
      // Walk-ins need no free slot (they join today's queue), only an active clinic and type.
      const clinic = await tx.clinic.findUnique({
        where: { id: p.clinicId },
        select: { active: true },
      });
      if (!clinic?.active || !loaded.type.active) {
        throw invalid('clinicId', 'Choose an active clinic and consultation type.');
      }
      startAt = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
      endAt = new Date(startAt.getTime() + loaded.type.defaultDurationMin * 60_000);
    } else {
      const wanted = new Date(p.startAt!).toISOString();
      const slot = loaded.day.slots.find((s) => s.start === wanted);
      if (!slot) {
        throw new AppError(409, 'SLOT_TAKEN', 'This time is not one of the doctor’s slots.', {
          startAt: 'unavailable',
        });
      }
      if (slot.unavailableReason === 'past') {
        throw new AppError(409, 'SLOT_TAKEN', 'This slot has already started.', {
          startAt: 'unavailable',
        });
      }
      if (slot.unavailableReason === 'busy') {
        if (!p.overbook) {
          throw new AppError(409, 'SLOT_TAKEN', 'This slot has just been booked. Choose another.', {
            startAt: 'taken',
          });
        }
        const used = await tx.appointment.count({
          where: {
            doctorUserId: p.doctorUserId,
            date: toDbDate(date),
            overbook: true,
            status: { in: SLOT_HOLDING },
            // Moving an overbooked patient within the day adds no one.
            ...(p.rescheduledFromId ? { id: { not: p.rescheduledFromId } } : {}),
          },
        });
        if (used >= loaded.bookingRules.overbookPerDay) {
          throw new AppError(
            409,
            'BOOKING_LIMIT',
            `The clinic allows ${loaded.bookingRules.overbookPerDay} overbooked patients per doctor per day.`,
          );
        }
        overbook = true;
      }
      startAt = new Date(slot.start);
      endAt = new Date(slot.end);
    }

    const duplicate = await tx.appointment.findFirst({
      where: {
        patientId: p.patientId,
        doctorUserId: p.doctorUserId,
        date: toDbDate(date),
        status: { in: [...ACTIVE_APPOINTMENT_STATUSES] },
        ...(p.rescheduledFromId ? { id: { not: p.rescheduledFromId } } : {}),
      },
      select: { startAt: true },
    });
    if (duplicate) {
      throw new AppError(
        409,
        'CONFLICT',
        `This patient is already booked with this doctor at ${istTime(duplicate.startAt)} that day.`,
      );
    }

    const last = await tx.appointment.aggregate({
      where: { doctorUserId: p.doctorUserId, clinicId: p.clinicId, date: toDbDate(date) },
      _max: { tokenNumber: true },
    });
    const status: AppointmentStatus = p.walkIn ? 'checked_in' : 'confirmed';
    const created = await tx.appointment.create({
      data: {
        organisationId: actor.organisationId,
        patientId: p.patientId,
        doctorUserId: p.doctorUserId,
        clinicId: p.clinicId,
        consultationTypeId: p.consultationTypeId,
        date: toDbDate(date),
        startAt,
        endAt,
        status,
        source: p.source,
        tokenNumber: (last._max.tokenNumber ?? 0) + 1,
        overbook,
        reason: p.reason ?? null,
        rescheduledFromId: p.rescheduledFromId ?? null,
        checkedInAt: p.walkIn ? now : null,
        createdByUserId: actor.userId,
      },
    });
    await this.record(tx, actor, created.id, null, status, now, null);
    await writeAudit(tx, request, {
      action: 'appointment.created',
      organisationId: actor.organisationId,
      actorUserId: actor.userId,
      entityType: 'appointment',
      entityId: created.id,
      metadata: {
        patientId: p.patientId,
        doctorUserId: p.doctorUserId,
        date,
        source: p.source,
        overbook,
        ...(p.rescheduledFromId ? { rescheduledFromId: p.rescheduledFromId } : {}),
      },
    });
    return created.id;
  }

  /**
   * Reads an appointment holding its row lock until the transaction ends, so two status
   * changes (or reschedules) of the same appointment never both pass the status check.
   * RLS still applies: another organisation's row is not found.
   */
  private async lockRow(tx: Tx, id: string) {
    await tx.$queryRaw`SELECT id FROM appointments WHERE id = ${id}::uuid FOR UPDATE`;
    return tx.appointment.findUnique({ where: { id } });
  }

  private record(
    tx: Tx,
    actor: Actor,
    appointmentId: string,
    fromStatus: AppointmentStatus | null,
    toStatus: AppointmentStatus,
    at: Date,
    note: string | null,
  ) {
    return tx.appointmentStatusHistory.create({
      data: {
        organisationId: actor.organisationId,
        appointmentId,
        fromStatus,
        toStatus,
        actorUserId: actor.userId,
        note,
        at,
      },
    });
  }

  private async detail(tx: Tx, id: string): Promise<AppointmentDetail> {
    const row = await tx.appointment.findUnique({
      where: { id },
      include: { ...include, history: { orderBy: { at: 'asc' } } },
    });
    if (!row) throw NOT_FOUND();
    const names = await this.names([row.doctorUserId, ...row.history.map((h) => h.actorUserId)]);
    return {
      ...this.toAppointment(row, names),
      history: row.history.map((h) => ({
        fromStatus: h.fromStatus,
        toStatus: h.toStatus,
        actorUserId: h.actorUserId,
        actorName: names.get(h.actorUserId) ?? null,
        note: h.note,
        at: h.at.toISOString(),
      })),
    };
  }

  /** Display names of staff (users are platform-level, outside tenant RLS). */
  private async names(userIds: string[]): Promise<Map<string, string | null>> {
    const ids = [...new Set(userIds)];
    if (ids.length === 0) return new Map();
    const users = await withAuth(this.s.db, (tx) =>
      tx.user.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true } }),
    );
    return new Map(users.map((u) => [u.id, u.displayName]));
  }

  private toAppointment(r: AppointmentRow, names: Map<string, string | null>): Appointment {
    return {
      id: r.id,
      patient: toSummary(r.patient),
      doctorUserId: r.doctorUserId,
      doctorName: names.get(r.doctorUserId) ?? null,
      clinicId: r.clinicId,
      clinicName: r.clinic.name,
      consultationTypeId: r.consultationTypeId,
      consultationTypeName: r.consultationType.name,
      mode: r.consultationType.mode,
      date: fromDbDate(r.date),
      startAt: r.startAt.toISOString(),
      endAt: r.endAt.toISOString(),
      startTime: istTime(r.startAt),
      status: r.status,
      source: r.source,
      tokenNumber: r.tokenNumber,
      overbook: r.overbook,
      reason: r.reason,
      cancelReason: r.cancelReason,
      rescheduledFromId: r.rescheduledFromId,
      rescheduledToId: r.rescheduledTo?.id ?? null,
      checkedInAt: r.checkedInAt?.toISOString() ?? null,
      consultationStartedAt: r.consultationStartedAt?.toISOString() ?? null,
      completedAt: r.completedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    };
  }
}
