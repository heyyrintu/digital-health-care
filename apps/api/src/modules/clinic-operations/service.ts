import { withAuth, withTenant, Prisma, type Tx } from '@dhc/db';
import { ClinicOperation, type PreviewClinicOperation, type Role } from '@dhc/contracts';
import { istDate } from '@dhc/domain';
import { randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { Services } from '../../services';
import { AppError } from '../../errors';
import { AppointmentService } from '../appointments/service';
import { loadDaySlots } from '../scheduling/availability';
import { writeAudit } from '../audit/write';
type Actor = { userId: string; organisationId: string; role: Role };
const conflict = (message = 'The session changed. Preview it again before applying.') =>
  new AppError(409, 'CONFLICT', message);
const invalid = (message: string) => new AppError(400, 'VALIDATION_FAILED', message);
const dbDate = (date: string) => new Date(date + 'T00:00:00Z');
export const sessionInstant = (date: string, time: string) => new Date(`${date}T${time}:00+05:30`);
const include = {
  patient: { select: { id: true, name: true, uhid: true, mergedIntoId: true, updatedAt: true } },
  bill: { select: { id: true, revision: true } },
  prepaidBooking: { select: { id: true, state: true } },
  consultation: { select: { id: true, revision: true } },
  vitals: { select: { id: true } },
  testOrders: { select: { id: true } },
  prescriptions: { select: { id: true, revision: true } },
} as const;
type Source = Prisma.AppointmentGetPayload<{ include: typeof include }>;
type Plan = {
  request: PreviewClinicOperation;
  rows: ClinicOperation['rows'];
  snapshotHash: string;
};
export class ClinicOperationsService {
  constructor(readonly s: Services) {}
  async allowed(tx: Tx, a: Actor, doctorId?: string) {
    if (
      !['clinic_admin', 'front_desk', 'doctor'].includes(a.role) ||
      !(await tx.membership.findFirst({
        where: { userId: a.userId, role: a.role, status: 'active' },
      })) ||
      (a.role === 'doctor' && doctorId && doctorId !== a.userId)
    )
      throw new AppError(403, 'FORBIDDEN', 'You do not have access to this clinic session.');
  }
  async options(a: Actor) {
    const data = await withTenant(this.s.db, a.organisationId, async (tx) => {
      await this.allowed(tx, a);
      return {
        members: await tx.membership.findMany({
          where: {
            role: 'doctor',
            status: 'active',
            ...(a.role === 'doctor' ? { userId: a.userId } : {}),
          },
          select: { userId: true },
        }),
        clinics: await tx.clinic.findMany({
          where: { active: true },
          select: { id: true, name: true },
          orderBy: { name: 'asc' },
        }),
      };
    });
    const doctors = await withAuth(this.s.db, (tx) =>
      tx.user.findMany({
        where: { id: { in: data.members.map((m) => m.userId) }, status: 'active' },
        select: { id: true, displayName: true, email: true },
      }),
    );
    return {
      notificationAvailable: !!this.s.operationMessagingSender,
      doctors: doctors.map((d) => ({ id: d.id, name: d.displayName ?? d.email ?? d.id })),
      clinics: data.clinics,
    };
  }
  async source(tx: Tx, b: PreviewClinicOperation) {
    const rows = await tx.appointment.findMany({
      where: {
        doctorUserId: b.doctorId,
        clinicId: b.clinicId,
        date: dbDate(b.date),
        startAt: { lt: sessionInstant(b.date, b.to) },
        endAt: { gt: sessionInstant(b.date, b.from) },
      },
      include,
      orderBy: { id: 'asc' },
      take: 201,
    });
    if (rows.length > 200)
      throw invalid('Narrow the source time range to at most 200 appointments.');
    return rows;
  }
  snapshot(rows: Source[]) {
    return this.s.inboxPayloadHash(
      'clinic-operation-snapshot',
      JSON.stringify(
        rows.map((r) => ({
          id: r.id,
          updatedAt: r.updatedAt,
          patientId: r.patientId,
          patientUpdatedAt: r.patient.updatedAt,
          mergedIntoId: r.patient.mergedIntoId,
          status: r.status,
          startAt: r.startAt,
          endAt: r.endAt,
          bill: r.bill,
          prepaid: r.prepaidBooking,
          consultation: r.consultation,
          vitals: r.vitals,
          testOrders: r.testOrders,
          prescriptions: r.prescriptions,
        })),
      ),
    );
  }
  issue(b: PreviewClinicOperation, r: Source) {
    if (b.kind === 'delay') {
      if (!['pending', 'confirmed', 'checked_in'].includes(r.status)) return 'not_waiting';
      return null;
    }
    if (!['pending', 'confirmed'].includes(r.status)) return 'not_booked';
    if (r.startAt <= this.s.now()) return 'already_started';
    if (r.bill || r.prepaidBooking) return 'financial_review';
    if (r.consultation || r.prescriptions.length || r.vitals || r.testOrders.length)
      return 'clinical_review';
    return null;
  }
  validate(b: PreviewClinicOperation) {
    if (b.date < istDate(this.s.now())) throw invalid('Choose today or a future clinic day.');
    if (b.kind === 'delay' && b.date !== istDate(this.s.now()))
      throw invalid('Delay estimates apply to today’s waiting appointments.');
    if (b.kind === 'reschedule' && (!b.targetDate || b.targetDate < istDate(this.s.now())))
      throw invalid('Choose a future destination session.');
    if (b.notify && !this.s.operationMessagingSender)
      throw conflict(
        'Automatic update notices are not configured. Turn off the additional notice option and contact patients manually.',
      );
  }
  async makePlan(tx: Tx, a: Actor, b: PreviewClinicOperation): Promise<Plan> {
    await this.allowed(tx, a, b.doctorId);
    this.validate(b);
    if (
      !(await tx.membership.findFirst({
        where: { userId: b.doctorId, role: 'doctor', status: 'active' },
      })) ||
      !(await tx.clinic.findFirst({ where: { id: b.clinicId, active: true } }))
    )
      throw invalid('Choose an active doctor and clinic.');
    if (
      b.kind === 'reschedule' &&
      !(await tx.clinic.findFirst({ where: { id: b.targetClinicId, active: true } }))
    )
      throw invalid('Choose an active destination clinic.');
    const source = await this.source(tx, b),
      rows: ClinicOperation['rows'] = [],
      taken = new Set<string>(),
      patients = new Set<string>();
    let ready = 0;
    const cache = new Map<string, Awaited<ReturnType<typeof loadDaySlots>>>();
    for (const r of source) {
      const issue = this.issue(b, r);
      let targetAt: string | null = null,
        targetIssue: string | null = null;
      if (!issue) {
        ready++;
        if (b.kind === 'reschedule') {
          const target = new Date(
            sessionInstant(b.targetDate!, b.targetTime!).getTime() +
              r.startAt.getTime() -
              sessionInstant(b.date, b.from).getTime(),
          );
          targetAt = target.toISOString();
          const key = r.consultationTypeId + ':' + istDate(target);
          if (!cache.has(key))
            cache.set(
              key,
              await loadDaySlots(
                tx,
                a.organisationId,
                {
                  doctorId: b.doctorId,
                  clinicId: b.targetClinicId!,
                  consultationTypeId: r.consultationTypeId,
                  date: istDate(target),
                  channel: 'staff',
                },
                this.s.now(),
                { ignoreAppointmentId: r.id },
              ),
            );
          const slot = cache.get(key)?.day.slots.find((s) => s.start === targetAt),
            patientId = r.patient.mergedIntoId ?? r.patientId;
          if (!slot || slot.unavailableReason || taken.has(targetAt))
            targetIssue = 'target_unavailable';
          if (patients.has(patientId + ':' + istDate(target))) targetIssue = 'target_duplicate';
          const duplicate = await tx.appointment.findFirst({
            where: {
              patientId,
              doctorUserId: b.doctorId,
              date: dbDate(istDate(target)),
              status: { in: ['pending', 'confirmed', 'checked_in', 'in_consultation'] },
              id: { not: r.id },
            },
          });
          if (duplicate) targetIssue = 'target_duplicate';
          if (
            b.targetClinicId === b.clinicId &&
            target < sessionInstant(b.date, b.to) &&
            new Date(target.getTime() + r.endAt.getTime() - r.startAt.getTime()) >
              sessionInstant(b.date, b.from)
          )
            targetIssue = 'target_in_closed_session';
          if (istDate(target) !== b.targetDate) targetIssue = 'target_unavailable';
          taken.add(targetAt);
          patients.add(patientId + ':' + istDate(target));
        }
      }
      rows.push({
        id: r.id,
        patientName: r.patient.name,
        uhid: r.patient.uhid,
        startAt: r.startAt.toISOString(),
        status: r.status,
        eligible: !issue,
        issue,
        targetAt,
        targetIssue,
        newAppointmentId: null,
      });
    }
    if (ready > 50) throw invalid('Narrow the time range to at most 50 eligible appointments.');
    if (b.kind === 'delay' && !ready) throw invalid('No waiting appointments match this session.');
    return { request: b, rows, snapshotHash: this.snapshot(source) };
  }
  out(row: Prisma.ClinicOperationGetPayload<object>) {
    const plan = JSON.parse(this.s.cipher.decrypt(row.planCipher)) as Plan,
      result = row.resultCipher
        ? (JSON.parse(this.s.cipher.decrypt(row.resultCipher)) as {
            rows: ClinicOperation['rows'];
            exceptionId: string | null;
            notificationsQueued: number;
            changedCount: number;
          })
        : null;
    return ClinicOperation.parse({
      id: row.id,
      createdByUserId: row.createdByUserId,
      kind: row.kind,
      state: row.state,
      revision: row.revision,
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      appliedAt: row.appliedAt?.toISOString() ?? null,
      request: plan.request,
      rows: result?.rows ?? plan.rows,
      canApply:
        row.state === 'preview' &&
        !plan.rows.some((r) => r.targetIssue) &&
        row.expiresAt > this.s.now(),
      exceptionId: result?.exceptionId ?? null,
      notificationsQueued: result?.notificationsQueued ?? 0,
      manualCount: plan.rows.filter((r) => !r.eligible).length,
      changedCount: result?.changedCount ?? 0,
    });
  }
  async preview(req: FastifyRequest, a: Actor, b: PreviewClinicOperation) {
    const requestHash = this.s.inboxPayloadHash('clinic-operation-request', JSON.stringify(b));
    return withTenant(this.s.db, a.organisationId, async (tx) => {
      await this.allowed(tx, a, b.doctorId);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`operation:${b.id}`},0))`;
      const prior = await tx.clinicOperation.findUnique({ where: { id: b.id } });
      if (prior) {
        if (prior.createdByUserId !== a.userId || prior.requestHash !== requestHash)
          throw conflict('This preview reference was already used.');
        return this.out(prior);
      }
      if (
        (await tx.clinicOperation.count({
          where: {
            createdByUserId: a.userId,
            createdAt: { gt: new Date(this.s.now().getTime() - 3600000) },
          },
        })) >= 30
      )
        throw new AppError(429, 'RATE_LIMITED', 'Too many previews. Please try later.');
      const plan = await this.makePlan(tx, a, b),
        now = this.s.now(),
        row = await tx.clinicOperation.create({
          data: {
            id: b.id,
            organisationId: a.organisationId,
            createdByUserId: a.userId,
            doctorId: b.doctorId,
            kind: b.kind,
            requestHash,
            snapshotHash: plan.snapshotHash,
            planCipher: this.s.cipher.encrypt(JSON.stringify(plan)),
            createdAt: now,
            expiresAt: new Date(now.getTime() + 900000),
          },
        });
      await this.audit(tx, req, a, row.id, 'previewed', {});
      return this.out(row);
    });
  }
  async view(a: Actor, id: string) {
    return withTenant(this.s.db, a.organisationId, async (tx) => {
      const row = await tx.clinicOperation.findUnique({ where: { id } });
      if (!row) throw new AppError(404, 'NOT_FOUND', 'Not found.');
      await this.allowed(tx, a, row.doctorId);
      return this.out(row);
    });
  }
  async list(a: Actor, cursor?: string) {
    return withTenant(this.s.db, a.organisationId, async (tx) => {
      await this.allowed(tx, a);
      const rows = await tx.clinicOperation.findMany({
        where: a.role === 'doctor' ? { doctorId: a.userId } : {},
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 21,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      return {
        data: rows.slice(0, 20).map((r) => this.out(r)),
        nextCursor: rows.length > 20 ? rows[19]!.id : null,
      };
    });
  }
  async apply(
    req: FastifyRequest,
    a: Actor,
    id: string,
    b: { revision: number; acknowledgeManual: boolean },
  ) {
    return withTenant(this.s.db, a.organisationId, async (tx) => {
      await tx.$queryRaw`SELECT id FROM clinic_operations WHERE id=${id}::uuid FOR UPDATE`;
      const row = await tx.clinicOperation.findUnique({ where: { id } });
      if (!row) throw new AppError(404, 'NOT_FOUND', 'Not found.');
      await this.allowed(tx, a, row.doctorId);
      if (row.createdByUserId !== a.userId)
        throw new AppError(403, 'FORBIDDEN', 'Apply your own reviewed preview.');
      if (row.state === 'applied') return this.out(row);
      if (row.revision !== b.revision || row.expiresAt <= this.s.now())
        throw conflict('This preview expired. Create a fresh preview.');
      const plan = JSON.parse(this.s.cipher.decrypt(row.planCipher)) as Plan,
        body = plan.request;
      if (plan.rows.some((r) => r.targetIssue))
        throw conflict('Choose a destination session with free matching slots.');
      if (plan.rows.some((r) => !r.eligible) && !b.acknowledgeManual)
        throw invalid('Acknowledge the appointments that still need individual review.');
      this.validate(body);
      const ids = plan.rows.map((r) => r.id).sort();
      if (ids.length)
        await tx.$queryRaw(
          Prisma.sql`SELECT id FROM appointments WHERE id IN (${Prisma.join(ids.map((x) => Prisma.sql`${x}::uuid`))}) ORDER BY id FOR UPDATE`,
        );
      const days = [
        ...new Set([
          body.date,
          ...(body.kind === 'reschedule'
            ? plan.rows.flatMap((r) => (r.targetAt ? [istDate(new Date(r.targetAt))] : []))
            : []),
        ]),
      ].sort();
      for (const day of days)
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`appt:${body.doctorId}:${day}`},0))`;
      const current = await this.source(tx, body);
      if (this.snapshot(current) !== row.snapshotHash) throw conflict();
      for (const r of current)
        if (this.issue(body, r) !== plan.rows.find((p) => p.id === r.id)?.issue) throw conflict();
      const appointments = new AppointmentService(this.s),
        now = this.s.now();
      let notices = 0,
        changed = 0,
        exceptionId: string | null = null;
      for (const item of plan.rows) {
        if (!item.eligible) continue;
        const old = current.find((r) => r.id === item.id)!;
        let newId: string | null = null;
        if (body.kind === 'reschedule') {
          newId = await appointments.place(tx, req, a, {
            patientId: old.patient.mergedIntoId ?? old.patientId,
            doctorUserId: old.doctorUserId,
            clinicId: body.targetClinicId!,
            consultationTypeId: old.consultationTypeId,
            startAt: item.targetAt!,
            walkIn: false,
            overbook: false,
            reason: old.reason,
            source: old.source,
            rescheduledFromId: old.id,
          });
          await tx.appointment.update({ where: { id: old.id }, data: { status: 'rescheduled' } });
          await appointments.record(tx, a, old.id, old.status, 'rescheduled', now, body.reason);
          item.newAppointmentId = newId;
        } else if (body.kind === 'cancel') {
          await tx.appointment.update({
            where: { id: old.id },
            data: { status: 'cancelled', cancelReason: body.reason },
          });
          await appointments.record(tx, a, old.id, old.status, 'cancelled', now, body.reason);
        } else
          await tx.appointment.update({
            where: { id: old.id },
            data: { delayMinutes: body.delayMinutes, delayUpdatedAt: now },
          });
        const update = await tx.clinicOperationalUpdate.create({
          data: {
            id: randomUUID(),
            organisationId: a.organisationId,
            operationId: id,
            appointmentId: old.id,
            replacementId: newId,
            kind: body.kind,
            delayMinutes: body.kind === 'delay' ? body.delayMinutes : 0,
            createdAt: now,
          },
        });
        if (body.notify) {
          const [count] = await tx.$queryRaw<
            { count: number }[]
          >`SELECT enqueue_clinic_operation_notice(${update.id}::uuid,${this.s.operationMessagingSender!}) AS count`;
          notices += count?.count ?? 0;
        }
        changed++;
      }
      if (body.kind !== 'delay') {
        const exception = await tx.availabilityException.create({
          data: {
            organisationId: a.organisationId,
            type: 'leave',
            doctorUserId: body.doctorId,
            clinicId: body.clinicId,
            startDate: dbDate(body.date),
            endDate: dbDate(body.date),
            startTime: body.from,
            endTime: body.to,
            reason: body.reason,
            createdByUserId: a.userId,
          },
        });
        exceptionId = exception.id;
      }
      const saved = await tx.clinicOperation.update({
        where: { id },
        data: {
          state: 'applied',
          revision: { increment: 1 },
          appliedAt: now,
          resultCipher: this.s.cipher.encrypt(
            JSON.stringify({
              rows: plan.rows,
              exceptionId,
              notificationsQueued: notices,
              changedCount: changed,
            }),
          ),
        },
      });
      await this.audit(tx, req, a, id, 'applied', {
        changed,
        manual: plan.rows.length - changed,
        notices,
        kind: body.kind,
      });
      return this.out(saved);
    });
  }
  async audit(
    tx: Tx,
    req: FastifyRequest,
    a: Actor,
    id: string,
    action: string,
    metadata: Prisma.InputJsonValue,
  ) {
    await writeAudit(tx, req, {
      organisationId: a.organisationId,
      actorUserId: a.userId,
      action: 'clinic_operation.' + action,
      entityType: 'clinic_operation',
      entityId: id,
      metadata,
    });
  }
}
