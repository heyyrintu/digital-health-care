import type {
  AvailabilityException,
  AvailabilityExceptionQuery,
  AvailabilityQuery,
  AvailabilityVersion,
  CreateAvailabilityExceptionBody,
  CreateAvailabilityVersionBody,
  Role,
  SlotsQuery,
  SlotsResponse,
  WeeklySchedule,
} from '@dhc/contracts';
import { Prisma, withTenant, type Tx } from '@dhc/db';
import {
  WEEKDAYS,
  addDays,
  istDate,
  minutesOf,
  slotsForDay,
  validateWeekly,
  type ScheduleVersion,
} from '@dhc/domain';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../../errors';
import type { Services } from '../../services';
import { writeAudit } from '../audit/write';
import { DEFAULT_BOOKING_RULES, type Actor } from './settings';

interface ScheduleActor extends Actor {
  role: Role;
}

const NOT_FOUND = () => new AppError(404, 'NOT_FOUND', 'Not found.');
const FORBIDDEN = () => new AppError(403, 'FORBIDDEN', 'You do not have access to this.');
const invalid = (field: string, message: string) =>
  new AppError(400, 'VALIDATION_FAILED', message, { [field]: 'invalid' });

/** Postgres `date` columns come back as UTC midnight. */
const toDbDate = (date: string) => new Date(`${date}T00:00:00.000Z`);
const fromDbDate = (date: Date) => date.toISOString().slice(0, 10);

/** Longest leave, holiday or extra-session run accepted in one go. */
const MAX_EXCEPTION_DAYS = 366;

type VersionRow = Prisma.AvailabilityVersionGetPayload<object>;
type ExceptionRow = Prisma.AvailabilityExceptionGetPayload<object>;

const toVersion = (v: VersionRow): AvailabilityVersion => ({
  id: v.id,
  doctorUserId: v.doctorUserId,
  clinicId: v.clinicId,
  consultationTypeId: v.consultationTypeId,
  effectiveFrom: fromDbDate(v.effectiveFrom),
  weekly: v.weekly as WeeklySchedule,
  slotMinutes: v.slotMinutes,
  bufferMinutes: v.bufferMinutes,
  createdAt: v.createdAt.toISOString(),
});

const toException = (e: ExceptionRow): AvailabilityException => ({
  id: e.id,
  type: e.type,
  doctorUserId: e.doctorUserId,
  clinicId: e.clinicId,
  consultationTypeId: e.consultationTypeId,
  startDate: fromDbDate(e.startDate),
  endDate: fromDbDate(e.endDate),
  startTime: e.startTime,
  endTime: e.endTime,
  reason: e.reason,
});

/** Drops days with no sessions and keeps each day's sessions in time order. */
function tidyWeekly(weekly: WeeklySchedule): WeeklySchedule {
  const out: WeeklySchedule = {};
  for (const day of WEEKDAYS) {
    const sessions = weekly[day];
    if (sessions?.length) out[day] = [...sessions].sort((a, b) => (a.start < b.start ? -1 : 1));
  }
  return out;
}

/**
 * Doctor availability (PRD §4.3, §5.5): weekly schedule versions, leave, holidays and
 * extra sessions, and the slots they produce. A doctor manages their own schedule; a
 * clinic admin manages anyone's and sets holidays. Nothing that has already started is
 * changed, so slots on past days stay as they were.
 */
export class AvailabilityService {
  constructor(private readonly s: Services) {}

  private today() {
    return istDate(this.s.now());
  }

  /** The doctor a change is for: a doctor acts for themselves, an admin names one. */
  private doctorFor(actor: ScheduleActor, doctorUserId: string | null | undefined): string {
    if (actor.role === 'doctor') {
      if (doctorUserId && doctorUserId !== actor.userId) throw FORBIDDEN();
      return actor.userId;
    }
    if (actor.role !== 'clinic_admin') throw FORBIDDEN();
    if (!doctorUserId) throw invalid('doctorUserId', 'Choose a doctor.');
    return doctorUserId;
  }

  private async requireDoctor(tx: Tx, userId: string) {
    const doctor = await tx.membership.findFirst({
      where: { userId, role: 'doctor', status: 'active' },
      select: { id: true },
    });
    if (!doctor) throw invalid('doctorUserId', 'Choose an active doctor.');
  }

  /** Foreign keys alone would accept another organisation's IDs; look them up under RLS. */
  private async requireClinic(tx: Tx, id: string) {
    const clinic = await tx.clinic.findUnique({ where: { id }, select: { active: true } });
    if (!clinic?.active) throw invalid('clinicId', 'Choose an active clinic.');
  }

  private async requireConsultationType(tx: Tx, id: string) {
    const type = await tx.consultationType.findUnique({ where: { id } });
    if (!type?.active) throw invalid('consultationTypeId', 'Choose an active consultation type.');
    return type;
  }

  async listVersions(actor: Actor, query: AvailabilityQuery): Promise<AvailabilityVersion[]> {
    const rows = await withTenant(this.s.db, actor.organisationId, (tx) =>
      tx.availabilityVersion.findMany({
        where: {
          doctorUserId: query.doctorId,
          clinicId: query.clinicId,
          consultationTypeId: query.consultationTypeId,
        },
        orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
        take: 200,
      }),
    );
    return rows.map(toVersion);
  }

  async createVersion(
    request: FastifyRequest,
    actor: ScheduleActor,
    body: CreateAvailabilityVersionBody,
  ): Promise<AvailabilityVersion> {
    const doctorUserId = this.doctorFor(actor, body.doctorUserId);
    if (body.effectiveFrom < this.today()) {
      throw invalid('effectiveFrom', 'A new schedule can start today at the earliest.');
    }
    try {
      return await withTenant(this.s.db, actor.organisationId, async (tx) => {
        await this.requireDoctor(tx, doctorUserId);
        await this.requireClinic(tx, body.clinicId);
        const type = await this.requireConsultationType(tx, body.consultationTypeId);
        const slotMinutes = body.slotMinutes ?? type.defaultDurationMin;
        const weekly = tidyWeekly(body.weekly);
        const problems = validateWeekly(weekly, slotMinutes);
        if (Object.keys(problems).length > 0) {
          throw new AppError(400, 'VALIDATION_FAILED', Object.values(problems)[0]!, problems);
        }

        const version = await tx.availabilityVersion.create({
          data: {
            organisationId: actor.organisationId,
            doctorUserId,
            clinicId: body.clinicId,
            consultationTypeId: body.consultationTypeId,
            effectiveFrom: toDbDate(body.effectiveFrom),
            weekly,
            slotMinutes,
            bufferMinutes: body.bufferMinutes,
            createdByUserId: actor.userId,
          },
        });
        await writeAudit(tx, request, {
          action: 'availability.version_created',
          organisationId: actor.organisationId,
          actorUserId: actor.userId,
          entityType: 'availability_version',
          entityId: version.id,
          metadata: { doctorUserId, effectiveFrom: body.effectiveFrom },
        });
        return toVersion(version);
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new AppError(
          409,
          'CONFLICT',
          'A schedule already starts on this date. Withdraw it first, or pick another date.',
          { effectiveFrom: 'taken' },
        );
      }
      throw error;
    }
  }

  async deleteVersion(request: FastifyRequest, actor: ScheduleActor, id: string): Promise<void> {
    await withTenant(this.s.db, actor.organisationId, async (tx) => {
      const version = await tx.availabilityVersion.findUnique({ where: { id } });
      if (!version) throw NOT_FOUND();
      this.doctorFor(actor, version.doctorUserId);
      if (fromDbDate(version.effectiveFrom) <= this.today()) {
        throw new AppError(
          409,
          'CONFLICT',
          'This schedule has already started. Set a new schedule from a later date instead.',
        );
      }
      await tx.availabilityVersion.delete({ where: { id } });
      await writeAudit(tx, request, {
        action: 'availability.version_deleted',
        organisationId: actor.organisationId,
        actorUserId: actor.userId,
        entityType: 'availability_version',
        entityId: id,
        metadata: { doctorUserId: version.doctorUserId },
      });
    });
  }

  async listExceptions(
    actor: Actor,
    query: AvailabilityExceptionQuery,
  ): Promise<AvailabilityException[]> {
    const from = query.from ?? this.today();
    const rows = await withTenant(this.s.db, actor.organisationId, (tx) =>
      tx.availabilityException.findMany({
        where: {
          endDate: { gte: toDbDate(from) },
          // A doctor's or clinic's list includes what applies to everyone (holidays).
          AND: [
            ...(query.doctorId
              ? [{ OR: [{ doctorUserId: null }, { doctorUserId: query.doctorId }] }]
              : []),
            ...(query.clinicId ? [{ OR: [{ clinicId: null }, { clinicId: query.clinicId }] }] : []),
          ],
        },
        orderBy: [{ startDate: 'asc' }, { startTime: 'asc' }],
        take: 200,
      }),
    );
    return rows.map(toException);
  }

  async createException(
    request: FastifyRequest,
    actor: ScheduleActor,
    body: CreateAvailabilityExceptionBody,
  ): Promise<AvailabilityException> {
    const { type, startDate, endDate } = body;
    const startTime = body.startTime ?? null;
    const endTime = body.endTime ?? null;
    const clinicId = body.clinicId ?? null;
    let consultationTypeId = body.consultationTypeId ?? null;
    let doctorUserId: string | null = null;

    if (startDate < this.today()) throw invalid('startDate', 'Pick today or a later date.');
    if (endDate < startDate) throw invalid('endDate', 'The end date must not be before the start.');
    if (endDate > addDays(startDate, MAX_EXCEPTION_DAYS - 1)) {
      throw invalid('endDate', 'Add at most a year at a time.');
    }
    if ((startTime === null) !== (endTime === null)) {
      throw invalid('endTime', 'Give both a start and an end time, or neither.');
    }
    if (startTime && endTime && minutesOf(endTime) <= minutesOf(startTime)) {
      throw invalid('endTime', 'The end time must be after the start time.');
    }

    if (type === 'holiday') {
      if (actor.role !== 'clinic_admin') throw FORBIDDEN();
      if (body.doctorUserId) throw invalid('doctorUserId', 'Holidays apply to a whole clinic.');
      consultationTypeId = null;
    } else {
      doctorUserId = this.doctorFor(actor, body.doctorUserId);
      if (type === 'leave') consultationTypeId = null;
      if (type === 'extra_session') {
        if (!clinicId) throw invalid('clinicId', 'Choose a clinic.');
        if (!consultationTypeId) throw invalid('consultationTypeId', 'Choose a consultation type.');
        if (!startTime) throw invalid('startTime', 'Give the session’s hours.');
      }
    }

    return withTenant(this.s.db, actor.organisationId, async (tx) => {
      if (doctorUserId) await this.requireDoctor(tx, doctorUserId);
      if (clinicId) await this.requireClinic(tx, clinicId);
      if (consultationTypeId) await this.requireConsultationType(tx, consultationTypeId);
      const exception = await tx.availabilityException.create({
        data: {
          organisationId: actor.organisationId,
          type,
          doctorUserId,
          clinicId,
          consultationTypeId,
          startDate: toDbDate(startDate),
          endDate: toDbDate(endDate),
          startTime,
          endTime,
          reason: body.reason ?? null,
          createdByUserId: actor.userId,
        },
      });
      await writeAudit(tx, request, {
        action: 'availability.exception_created',
        organisationId: actor.organisationId,
        actorUserId: actor.userId,
        entityType: 'availability_exception',
        entityId: exception.id,
        metadata: { type, doctorUserId, clinicId, startDate, endDate },
      });
      return toException(exception);
    });
  }

  async deleteException(request: FastifyRequest, actor: ScheduleActor, id: string): Promise<void> {
    await withTenant(this.s.db, actor.organisationId, async (tx) => {
      const exception = await tx.availabilityException.findUnique({ where: { id } });
      if (!exception) throw NOT_FOUND();
      if (exception.type === 'holiday' || !exception.doctorUserId) {
        if (actor.role !== 'clinic_admin') throw FORBIDDEN();
      } else {
        this.doctorFor(actor, exception.doctorUserId);
      }
      if (fromDbDate(exception.startDate) <= this.today()) {
        throw new AppError(
          409,
          'CONFLICT',
          'This has already started and can no longer be removed.',
        );
      }
      await tx.availabilityException.delete({ where: { id } });
      await writeAudit(tx, request, {
        action: 'availability.exception_deleted',
        organisationId: actor.organisationId,
        actorUserId: actor.userId,
        entityType: 'availability_exception',
        entityId: id,
        metadata: { type: exception.type, doctorUserId: exception.doctorUserId },
      });
    });
  }

  /** One day's slots. Appointments will mark slots busy once booking lands. */
  async slots(actor: Actor, query: SlotsQuery): Promise<SlotsResponse> {
    const { doctorId, clinicId, consultationTypeId, date, channel } = query;
    const loaded = await withTenant(this.s.db, actor.organisationId, async (tx) => {
      const [clinic, type, rules] = await Promise.all([
        tx.clinic.findUnique({ where: { id: clinicId }, select: { active: true } }),
        tx.consultationType.findUnique({ where: { id: consultationTypeId } }),
        tx.bookingRules.findUnique({ where: { organisationId: actor.organisationId } }),
      ]);
      if (!clinic || !type) throw NOT_FOUND();
      if (!clinic.active || !type.active) return null;

      const day = toDbDate(date);
      const [version, exceptions] = await Promise.all([
        tx.availabilityVersion.findFirst({
          where: {
            doctorUserId: doctorId,
            clinicId,
            consultationTypeId,
            effectiveFrom: { lte: day },
          },
          orderBy: { effectiveFrom: 'desc' },
        }),
        tx.availabilityException.findMany({
          where: {
            startDate: { lte: day },
            endDate: { gte: day },
            AND: [
              { OR: [{ doctorUserId: null }, { doctorUserId: doctorId }] },
              { OR: [{ clinicId: null }, { clinicId }] },
              { OR: [{ consultationTypeId: null }, { consultationTypeId }] },
            ],
          },
        }),
      ]);
      return { type, rules, version, exceptions };
    });
    if (!loaded) return { date, slots: [], closed: 'no_schedule' };

    const { type, rules, version, exceptions } = loaded;
    const versions: ScheduleVersion[] = version
      ? [
          {
            effectiveFrom: fromDbDate(version.effectiveFrom),
            weekly: version.weekly as WeeklySchedule,
            slotMinutes: version.slotMinutes,
            bufferMinutes: version.bufferMinutes,
          },
        ]
      : [];
    return slotsForDay({
      date,
      versions,
      exceptions: exceptions.map((e) => ({
        type: e.type,
        startDate: fromDbDate(e.startDate),
        endDate: fromDbDate(e.endDate),
        startTime: e.startTime,
        endTime: e.endTime,
      })),
      window: rules
        ? { horizonDays: rules.horizonDays, sameDayCutoffMinutes: rules.sameDayCutoffMinutes }
        : DEFAULT_BOOKING_RULES,
      now: this.s.now(),
      channel,
      defaultSlotMinutes: type.defaultDurationMin,
    });
  }
}
