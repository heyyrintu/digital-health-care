import type {
  BookingRules,
  Clinic,
  ConsultationType,
  CreateClinicBody,
  CreateConsultationTypeBody,
  Doctor,
  UpdateClinicBody,
  UpdateConsultationTypeBody,
} from '@dhc/contracts';
import { Prisma, withAuth, withTenant } from '@dhc/db';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../../errors';
import type { Services } from '../../services';
import { writeAudit } from '../audit/write';

export interface Actor {
  userId: string;
  organisationId: string;
}

/** PRD §4.3 defaults until a clinic admin sets its own. */
export const DEFAULT_BOOKING_RULES: BookingRules = { horizonDays: 30, sameDayCutoffMinutes: 60 };

const NOT_FOUND = () => new AppError(404, 'NOT_FOUND', 'Not found.');
const DUPLICATE_NAME = () =>
  new AppError(409, 'CONFLICT', 'This name is already in use.', { name: 'taken' });

const toClinic = (c: Prisma.ClinicGetPayload<object>): Clinic => ({
  id: c.id,
  name: c.name,
  address: c.address,
  phone: c.phone,
  active: c.active,
});

const toConsultationType = (t: Prisma.ConsultationTypeGetPayload<object>): ConsultationType => ({
  id: t.id,
  name: t.name,
  mode: t.mode,
  defaultDurationMin: t.defaultDurationMin,
  feePaise: t.feePaise,
  followUpFeePaise: t.followUpFeePaise,
  requiresPrepayment: t.requiresPrepayment,
  active: t.active,
});

/**
 * What a clinic admin sets up before schedules (PRD §4.3): clinics (consulting
 * locations), consultation types with fees, and the booking rules. Deactivated, never
 * deleted, so past appointments keep their meaning.
 */
export class SchedulingSettingsService {
  constructor(private readonly s: Services) {}

  async listClinics(actor: Actor): Promise<Clinic[]> {
    const rows = await withTenant(this.s.db, actor.organisationId, (tx) =>
      tx.clinic.findMany({ orderBy: [{ active: 'desc' }, { name: 'asc' }] }),
    );
    return rows.map(toClinic);
  }

  async createClinic(request: FastifyRequest, actor: Actor, body: CreateClinicBody) {
    return this.uniqueName(() =>
      withTenant(this.s.db, actor.organisationId, async (tx) => {
        const clinic = await tx.clinic.create({
          data: { ...body, organisationId: actor.organisationId },
        });
        await writeAudit(tx, request, {
          action: 'clinic.created',
          organisationId: actor.organisationId,
          actorUserId: actor.userId,
          entityType: 'clinic',
          entityId: clinic.id,
        });
        return toClinic(clinic);
      }),
    );
  }

  async updateClinic(request: FastifyRequest, actor: Actor, id: string, body: UpdateClinicBody) {
    return this.uniqueName(() =>
      withTenant(this.s.db, actor.organisationId, async (tx) => {
        if (!(await tx.clinic.findUnique({ where: { id }, select: { id: true } }))) {
          throw NOT_FOUND();
        }
        const clinic = await tx.clinic.update({ where: { id }, data: body });
        await writeAudit(tx, request, {
          action: 'clinic.updated',
          organisationId: actor.organisationId,
          actorUserId: actor.userId,
          entityType: 'clinic',
          entityId: id,
          metadata: { fields: Object.keys(body) },
        });
        return toClinic(clinic);
      }),
    );
  }

  async listConsultationTypes(actor: Actor): Promise<ConsultationType[]> {
    const rows = await withTenant(this.s.db, actor.organisationId, (tx) =>
      tx.consultationType.findMany({ orderBy: [{ active: 'desc' }, { name: 'asc' }] }),
    );
    return rows.map(toConsultationType);
  }

  async createConsultationType(
    request: FastifyRequest,
    actor: Actor,
    body: CreateConsultationTypeBody,
  ) {
    return this.uniqueName(() =>
      withTenant(this.s.db, actor.organisationId, async (tx) => {
        const type = await tx.consultationType.create({
          data: { ...body, organisationId: actor.organisationId },
        });
        await writeAudit(tx, request, {
          action: 'consultation_type.created',
          organisationId: actor.organisationId,
          actorUserId: actor.userId,
          entityType: 'consultation_type',
          entityId: type.id,
        });
        return toConsultationType(type);
      }),
    );
  }

  async updateConsultationType(
    request: FastifyRequest,
    actor: Actor,
    id: string,
    body: UpdateConsultationTypeBody,
  ) {
    return this.uniqueName(() =>
      withTenant(this.s.db, actor.organisationId, async (tx) => {
        if (!(await tx.consultationType.findUnique({ where: { id }, select: { id: true } }))) {
          throw NOT_FOUND();
        }
        const type = await tx.consultationType.update({ where: { id }, data: body });
        await writeAudit(tx, request, {
          action: 'consultation_type.updated',
          organisationId: actor.organisationId,
          actorUserId: actor.userId,
          entityType: 'consultation_type',
          entityId: id,
          metadata: { fields: Object.keys(body) },
        });
        return toConsultationType(type);
      }),
    );
  }

  async bookingRules(actor: Actor): Promise<BookingRules> {
    const row = await withTenant(this.s.db, actor.organisationId, (tx) =>
      tx.bookingRules.findUnique({ where: { organisationId: actor.organisationId } }),
    );
    return row
      ? { horizonDays: row.horizonDays, sameDayCutoffMinutes: row.sameDayCutoffMinutes }
      : DEFAULT_BOOKING_RULES;
  }

  async updateBookingRules(
    request: FastifyRequest,
    actor: Actor,
    body: BookingRules,
  ): Promise<BookingRules> {
    return withTenant(this.s.db, actor.organisationId, async (tx) => {
      const row = await tx.bookingRules.upsert({
        where: { organisationId: actor.organisationId },
        create: { ...body, organisationId: actor.organisationId },
        update: body,
      });
      await writeAudit(tx, request, {
        action: 'booking_rules.updated',
        organisationId: actor.organisationId,
        actorUserId: actor.userId,
        metadata: { ...body },
      });
      return { horizonDays: row.horizonDays, sameDayCutoffMinutes: row.sameDayCutoffMinutes };
    });
  }

  /** Active doctors, for schedule and booking pickers. */
  async listDoctors(actor: Actor): Promise<Doctor[]> {
    const memberships = await withTenant(this.s.db, actor.organisationId, (tx) =>
      tx.membership.findMany({
        where: { role: 'doctor', status: 'active' },
        select: { userId: true },
      }),
    );
    const users = await withAuth(this.s.db, (tx) =>
      tx.user.findMany({
        where: { id: { in: memberships.map((m) => m.userId) }, status: 'active' },
        select: { id: true, displayName: true },
      }),
    );
    return users
      .map((u) => ({ userId: u.id, displayName: u.displayName }))
      .sort((a, b) => (a.displayName ?? '').localeCompare(b.displayName ?? ''));
  }

  private async uniqueName<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw DUPLICATE_NAME();
      }
      throw error;
    }
  }
}
