import {
  ACTIVE_APPOINTMENT_STATUSES,
  type BookingOptions,
  type PortalAppointment,
  type PortalAppointmentList,
  type PortalBookBody,
  type PortalCancelBody,
  type PortalPrescription,
  type PortalSlotsQuery,
  type SlotsResponse,
} from '@dhc/contracts';
import { withAuth, withTenant, type Prisma, type Tx } from '@dhc/db';
import { istDate } from '@dhc/domain';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../../errors';
import type { Services } from '../../services';
import { AppointmentService } from '../appointments/service';
import { writeAudit } from '../audit/write';
import { SigningService } from '../prescribing/signing';
import { loadDaySlots } from '../scheduling/availability';
import { DEFAULT_BOOKING_RULES, toRules } from '../scheduling/settings';
import { accountHistoryWhere, accountPhone, ownHistory, ownPatient } from './account';
import { PortalService } from './service';

interface Actor {
  userId: string;
  organisationId: string;
}

const NOT_FOUND = () => new AppError(404, 'NOT_FOUND', 'Not found.');
const fromDbDate = (date: Date) => date.toISOString().slice(0, 10);
const istTime = (instant: Date) =>
  new Date(instant.getTime() + 330 * 60_000).toISOString().slice(11, 16);

/**
 * Patients book in-person consultations that need no payment at booking. Online modes need
 * the identity check and telemedicine consent, and prepaid ones need Cashfree (PRD §4.3);
 * both come with those features.
 */
const bookableType: Prisma.ConsultationTypeWhereInput = {
  active: true,
  mode: 'in_person',
  requiresPrepayment: false,
};

const appointmentInclude = {
  patient: {
    select: {
      id: true,
      name: true,
      uhid: true,
      mergedInto: { select: { id: true, name: true, uhid: true } },
    },
  },
  clinic: { select: { name: true } },
  consultationType: { select: { name: true, mode: true } },
  prescriptions: {
    where: { status: { in: ['signed', 'void'] as ('signed' | 'void')[] } },
    orderBy: { version: 'desc' },
    take: 1,
    select: { id: true, number: true, version: true, status: true },
  },
} as const;
type AppointmentRow = Prisma.AppointmentGetPayload<{ include: typeof appointmentInclude }>;

/** Display names of doctors (users sit outside tenant row-level security). */
async function doctorNames(s: Services, ids: string[]): Promise<Map<string, string | null>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const users = await withAuth(s.db, (tx) =>
    tx.user.findMany({ where: { id: { in: unique } }, select: { id: true, displayName: true } }),
  );
  return new Map(users.map((u) => [u.id, u.displayName]));
}

/**
 * Self-booking, the family's appointments and prescriptions (PRD §4.3, §4.4). Every record
 * is checked against the account; health data needs the onboarding consents.
 */
export class PortalBookingService {
  private readonly appointments: AppointmentService;
  private readonly signing: SigningService;
  private readonly portal: PortalService;

  constructor(private readonly s: Services) {
    this.appointments = new AppointmentService(s);
    this.signing = new SigningService(s);
    this.portal = new PortalService(s);
  }

  async options(actor: Actor): Promise<BookingOptions> {
    return withTenant(this.s.db, actor.organisationId, async (tx) => {
      const clinics = await tx.clinic.findMany({
        where: { active: true },
        orderBy: { name: 'asc' },
      });
      const types = await tx.consultationType.findMany({
        where: bookableType,
        orderBy: { name: 'asc' },
      });
      const doctors = await tx.membership.findMany({
        where: { role: 'doctor', status: 'active' },
        select: { userId: true },
      });
      const rules = await this.rules(tx, actor);
      const names = await doctorNames(
        this.s,
        doctors.map((d) => d.userId),
      );
      return {
        doctors: doctors
          .map((d) => ({ userId: d.userId, displayName: names.get(d.userId) ?? null }))
          .sort((a, b) => (a.displayName ?? '').localeCompare(b.displayName ?? '')),
        clinics: clinics.map((c) => ({ id: c.id, name: c.name, address: c.address })),
        consultationTypes: types.map((t) => ({
          id: t.id,
          name: t.name,
          mode: t.mode,
          defaultDurationMin: t.defaultDurationMin,
          feePaise: t.feePaise,
        })),
        horizonDays: rules.horizonDays,
        cancelCutoffMinutes: rules.cancelCutoffMinutes,
        maxActiveBookings: rules.maxActiveBookings,
      };
    });
  }

  async slots(actor: Actor, query: PortalSlotsQuery): Promise<SlotsResponse> {
    return withTenant(this.s.db, actor.organisationId, async (tx) => {
      await this.requireBookable(tx, query.consultationTypeId, query.doctorId);
      const loaded = await loadDaySlots(
        tx,
        actor.organisationId,
        { ...query, channel: 'patient' },
        this.s.now(),
      );
      if (!loaded) throw NOT_FOUND();
      return loaded.day;
    });
  }

  async book(
    request: FastifyRequest,
    actor: Actor,
    body: PortalBookBody,
  ): Promise<PortalAppointment> {
    const phone = await accountPhone(this.s, actor.userId);
    return withTenant(this.s.db, actor.organisationId, async (tx) => {
      await this.portal.requireConsents(tx, actor);
      await ownPatient(tx, phone, body.patientId);
      await this.requireBookable(tx, body.consultationTypeId, body.doctorUserId);
      const rules = await this.rules(tx, actor);
      const now = this.s.now();

      // Serialise this patient's bookings so the limits below hold under double taps.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`portal:${body.patientId}`}, 0))`;
      const active = await tx.appointment.count({
        where: {
          patientId: body.patientId,
          status: { in: ['pending', 'confirmed'] },
          startAt: { gte: now },
        },
      });
      if (active >= rules.maxActiveBookings) {
        throw new AppError(
          409,
          'BOOKING_LIMIT',
          `You can hold ${rules.maxActiveBookings} upcoming bookings at a time. Cancel one to book another.`,
          { reason: 'active_bookings' },
        );
      }
      if (rules.noShowLimit > 0) {
        const since = new Date(now.getTime() - rules.noShowWindowDays * 86_400_000);
        const noShows = await tx.appointment.count({
          where: { patientId: body.patientId, status: 'no_show', startAt: { gte: since } },
        });
        if (noShows >= rules.noShowLimit) {
          throw new AppError(
            409,
            'BOOKING_LIMIT',
            'Online booking is paused after missed appointments. Please call the clinic to book.',
            { reason: 'no_shows' },
          );
        }
      }

      const id = await this.appointments.place(
        tx,
        request,
        { ...actor, role: 'patient' },
        {
          patientId: body.patientId,
          doctorUserId: body.doctorUserId,
          clinicId: body.clinicId,
          consultationTypeId: body.consultationTypeId,
          startAt: body.startAt,
          walkIn: false,
          overbook: false,
          reason: body.reason ?? null,
          source: 'app',
          channel: 'patient',
          status: rules.autoConfirm ? 'confirmed' : 'pending',
        },
      );
      const row = await tx.appointment.findUniqueOrThrow({
        where: { id },
        include: appointmentInclude,
      });
      const names = await doctorNames(this.s, [row.doctorUserId]);
      return this.toAppointment(row, names, rules.cancelCutoffMinutes, now);
    });
  }

  async list(actor: Actor): Promise<PortalAppointmentList> {
    const phone = await accountPhone(this.s, actor.userId);
    return withTenant(this.s.db, actor.organisationId, async (tx) => {
      await this.portal.requireConsents(tx, actor);
      const rows = await tx.appointment.findMany({
        where: { patient: accountHistoryWhere(phone), status: { not: 'rescheduled' } },
        include: appointmentInclude,
        orderBy: { startAt: 'asc' },
        take: 200,
      });
      const rules = await this.rules(tx, actor);
      const now = this.s.now();
      const names = await doctorNames(
        this.s,
        rows.map((r) => r.doctorUserId),
      );
      const all = rows.map((r) => this.toAppointment(r, names, rules.cancelCutoffMinutes, now));
      // Still to happen: booked or in progress, today or later (IST).
      const today = istDate(now);
      const isUpcoming = (a: PortalAppointment) =>
        (ACTIVE_APPOINTMENT_STATUSES as readonly string[]).includes(a.status) && a.date >= today;
      return {
        upcoming: all.filter(isUpcoming),
        past: all.filter((a) => !isUpcoming(a)).reverse(),
      };
    });
  }

  async cancel(
    request: FastifyRequest,
    actor: Actor,
    id: string,
    body: PortalCancelBody,
  ): Promise<PortalAppointment> {
    const phone = await accountPhone(this.s, actor.userId);
    return withTenant(this.s.db, actor.organisationId, async (tx) => {
      await this.portal.requireConsents(tx, actor);
      const row = await this.appointments.lockRow(tx, id);
      if (!row) throw NOT_FOUND();
      await ownPatient(tx, phone, row.patientId);
      const rules = await this.rules(tx, actor);
      const now = this.s.now();
      if (!['pending', 'confirmed'].includes(row.status)) {
        throw new AppError(409, 'CONFLICT', 'This appointment can no longer be cancelled.');
      }
      if (row.startAt.getTime() - now.getTime() < rules.cancelCutoffMinutes * 60_000) {
        throw new AppError(
          409,
          'CONFLICT',
          'It is too close to the appointment to cancel online. Please call the clinic.',
          { reason: 'cutoff' },
        );
      }
      const reason = body.reason ?? 'Cancelled by the patient';
      await tx.appointment.update({
        where: { id },
        data: { status: 'cancelled', cancelReason: reason },
      });
      await this.appointments.record(
        tx,
        { ...actor, role: 'patient' },
        id,
        row.status,
        'cancelled',
        now,
        reason,
      );
      await writeAudit(tx, request, {
        action: 'appointment.status_changed',
        organisationId: actor.organisationId,
        actorUserId: actor.userId,
        entityType: 'appointment',
        entityId: id,
        metadata: { from: row.status, to: 'cancelled', source: 'patient_app' },
      });
      const updated = await tx.appointment.findUniqueOrThrow({
        where: { id },
        include: appointmentInclude,
      });
      const names = await doctorNames(this.s, [updated.doctorUserId]);
      return this.toAppointment(updated, names, rules.cancelCutoffMinutes, now);
    });
  }

  /** Every signed version, newest first; amendments show as superseded, voided ones as void. */
  async prescriptions(actor: Actor): Promise<PortalPrescription[]> {
    const phone = await accountPhone(this.s, actor.userId);
    return withTenant(this.s.db, actor.organisationId, async (tx) => {
      await this.portal.requireConsents(tx, actor);
      const patients = await tx.patient.findMany({
        where: accountHistoryWhere(phone),
        select: { id: true, name: true, mergedInto: { select: { id: true, name: true } } },
      });
      const rows = await tx.prescription.findMany({
        where: {
          status: { in: ['signed', 'superseded', 'void'] },
          patientId: { in: patients.map((p) => p.id) },
        },
        orderBy: [{ signedAt: 'desc' }, { version: 'desc' }],
        take: 200,
      });
      const visits = await tx.appointment.findMany({
        where: { id: { in: [...new Set(rows.map((r) => r.appointmentId))] } },
        select: { id: true, date: true },
      });
      // A merged duplicate's prescriptions show under the record that was kept.
      const patientOf = new Map(
        patients.map((p) => [p.id, p.mergedInto ?? { id: p.id, name: p.name }]),
      );
      const dateOf = new Map(visits.map((v) => [v.id, fromDbDate(v.date)]));
      const names = await doctorNames(
        this.s,
        rows.map((r) => r.doctorUserId),
      );
      return rows.map((r) => ({
        id: r.id,
        number: r.number!,
        version: r.version,
        status: r.status as 'signed' | 'superseded' | 'void',
        patient: patientOf.get(r.patientId)!,
        doctorName: names.get(r.doctorUserId) ?? null,
        date: dateOf.get(r.appointmentId)!,
        signedAt: r.signedAt?.toISOString() ?? null,
      }));
    });
  }

  async prescriptionPdf(request: FastifyRequest, actor: Actor, id: string) {
    const phone = await accountPhone(this.s, actor.userId);
    return this.signing.pdf(request, { ...actor, role: 'patient' }, id, async (tx, patientId) => {
      await this.portal.requireConsents(tx, actor);
      await ownHistory(tx, phone, patientId);
    });
  }

  private async rules(tx: Tx, actor: Actor) {
    const row = await tx.bookingRules.findUnique({
      where: { organisationId: actor.organisationId },
    });
    return row ? toRules(row) : DEFAULT_BOOKING_RULES;
  }

  /** The consultation type is open to patients and the doctor is active. */
  private async requireBookable(tx: Tx, consultationTypeId: string, doctorUserId: string) {
    const type = await tx.consultationType.findFirst({
      where: { AND: [{ id: consultationTypeId }, bookableType] },
      select: { id: true },
    });
    if (!type) {
      throw new AppError(
        400,
        'VALIDATION_FAILED',
        'This consultation cannot be booked in the app yet. Please call the clinic.',
        { consultationTypeId: 'not_bookable' },
      );
    }
    const doctor = await tx.membership.findFirst({
      where: { userId: doctorUserId, role: 'doctor', status: 'active' },
      select: { id: true },
    });
    if (!doctor) throw NOT_FOUND();
  }

  private toAppointment(
    r: AppointmentRow,
    names: Map<string, string | null>,
    cancelCutoffMinutes: number,
    now: Date,
  ): PortalAppointment {
    const prescription = r.prescriptions[0];
    return {
      id: r.id,
      // A merged duplicate's visits show under the record that was kept.
      patient: r.patient.mergedInto ?? {
        id: r.patient.id,
        name: r.patient.name,
        uhid: r.patient.uhid,
      },
      doctorName: names.get(r.doctorUserId) ?? null,
      clinicName: r.clinic.name,
      consultationTypeName: r.consultationType.name,
      mode: r.consultationType.mode,
      date: fromDbDate(r.date),
      startAt: r.startAt.toISOString(),
      startTime: istTime(r.startAt),
      tokenNumber: r.tokenNumber,
      status: r.status,
      reason: r.reason,
      canCancel:
        ['pending', 'confirmed'].includes(r.status) &&
        r.startAt.getTime() - now.getTime() >= cancelCutoffMinutes * 60_000,
      prescription: prescription
        ? {
            id: prescription.id,
            number: prescription.number!,
            version: prescription.version,
            status: prescription.status as 'signed' | 'void',
          }
        : null,
    };
  }
}
