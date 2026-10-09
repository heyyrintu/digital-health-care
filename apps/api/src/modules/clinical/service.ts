import {
  ConsultationNotes,
  type Allergy,
  type AppointmentStatus,
  type ChartSource,
  type ConsultationRecord,
  type ConsultationView,
  type CreateAllergyBody,
  type CreateConditionBody,
  type CreateMedicationBody,
  type CurrentMedication,
  type MedicalCondition,
  type PatientChart,
  type RecentVisit,
  type Role,
  type SaveConsultationBody,
  type Vitals,
  type VitalsBody,
} from '@dhc/contracts';
import { withAuth, withTenant, type Prisma, type Tx } from '@dhc/db';
import { bmiOf } from '@dhc/domain';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../../errors';
import type { Services } from '../../services';
import { AppointmentService } from '../appointments/service';
import { writeAudit } from '../audit/write';
import { assertNotMerged, historyIds, liveId } from '../patients/merged';

interface Actor {
  userId: string;
  organisationId: string;
  role: Role;
}

export type ChartKind = 'allergies' | 'conditions' | 'medications';

const NOT_FOUND = () => new AppError(404, 'NOT_FOUND', 'Not found.');
const fromDbDate = (date: Date) => date.toISOString().slice(0, 10);
const toDbDate = (date: string) => new Date(`${date}T00:00:00.000Z`);
const num = (d: Prisma.Decimal | null) => (d === null ? null : Number(d));

/** The doctor writes notes and the prescription from arrival until the visit is over (PRD §6.1). */
export const NOTE_STATUSES: AppointmentStatus[] = ['checked_in', 'in_consultation', 'completed'];
/** Vitals can be taken any time before or during the visit, not for visits that did not happen. */
const VITALS_STATUSES: AppointmentStatus[] = [
  'pending',
  'confirmed',
  'checked_in',
  'in_consultation',
  'completed',
];

/**
 * Row lock on the visit, so a save and a status change of the same visit happen one after
 * the other. RLS still applies: another organisation's visit is not found.
 */
export async function lockVisit(tx: Tx, id: string) {
  await tx.$queryRaw`SELECT id FROM appointments WHERE id = ${id}::uuid FOR UPDATE`;
  const row = await tx.appointment.findUnique({ where: { id } });
  if (!row) throw NOT_FOUND();
  return row;
}

const AUDIT_NAMES: Record<ChartKind, string> = {
  allergies: 'allergy',
  conditions: 'condition',
  medications: 'medication',
};

/**
 * The clinical record (PRD §6.1): the patient chart, a visit's vitals and the doctor's
 * consultation notes. Chart and notes are doctors' only; front desk records vitals
 * (PRD §3.2). Every view of clinical data is audited (access-control policy). Notes are
 * stored encrypted with the field cipher.
 */
export class ClinicalService {
  private readonly appointments: AppointmentService;

  constructor(private readonly s: Services) {
    this.appointments = new AppointmentService(s);
  }

  // ---- Chart ------------------------------------------------------------------------

  async chart(request: FastifyRequest, actor: Actor, id: string): Promise<PatientChart> {
    // A merged duplicate's chart is the kept record's: entries moved there, and visits from
    // both records show.
    let patientId = id;
    const data = await withTenant(this.s.db, actor.organisationId, async (tx) => {
      const patient = await tx.patient.findUnique({ where: { id } });
      if (!patient) throw NOT_FOUND();
      patientId = liveId(patient);
      const live = { patientId, removedAt: null };
      const order = { createdAt: 'asc' } as const;
      // One after another: a transaction is one connection, which runs one query at a time.
      const allergies = await tx.allergy.findMany({ where: live, orderBy: order });
      const conditions = await tx.medicalCondition.findMany({ where: live, orderBy: order });
      const medications = await tx.currentMedication.findMany({ where: live, orderBy: order });
      const visits = await tx.consultation.findMany({
        where: {
          patientId: { in: await historyIds(tx, patientId) },
          appointment: { status: 'completed' },
        },
        include: { appointment: { select: { date: true, startAt: true } } },
        orderBy: { appointment: { startAt: 'desc' } },
        take: 5,
      });
      await this.audit(tx, request, actor, 'chart.viewed', 'patient', patientId);
      return { allergies, conditions, medications, visits };
    });

    const names = await this.names([
      ...data.allergies.map((a) => a.recordedByUserId),
      ...data.conditions.map((c) => c.recordedByUserId),
      ...data.medications.map((m) => m.recordedByUserId),
      ...data.visits.map((v) => v.doctorUserId),
    ]);
    const entry = (e: {
      id: string;
      source: ChartSource;
      createdAt: Date;
      recordedByUserId: string;
    }) => ({
      id: e.id,
      source: e.source,
      createdAt: e.createdAt.toISOString(),
      recordedByName: names.get(e.recordedByUserId) ?? null,
    });
    return {
      patientId,
      allergies: data.allergies.map((a) => ({
        ...entry(a),
        substance: a.substance,
        reaction: a.reaction,
      })),
      conditions: data.conditions.map((c) => ({
        ...entry(c),
        name: c.name,
        icd10Code: c.icd10Code,
      })),
      medications: data.medications.map((m) => ({ ...entry(m), name: m.name, dose: m.dose })),
      recentVisits: data.visits.map((v): RecentVisit => {
        const notes = this.decrypt(v.notesCipher);
        return {
          appointmentId: v.appointmentId,
          date: fromDbDate(v.appointment.date),
          doctorName: names.get(v.doctorUserId) ?? null,
          chiefComplaint: notes.chiefComplaint,
          diagnoses: notes.diagnoses,
        };
      }),
    };
  }

  async addAllergy(
    request: FastifyRequest,
    actor: Actor,
    patientId: string,
    body: CreateAllergyBody,
  ): Promise<Allergy> {
    const row = await this.addEntry(
      request,
      actor,
      patientId,
      'allergies',
      body.source,
      (tx, base) =>
        tx.allergy.create({
          data: { ...base, substance: body.substance, reaction: body.reaction ?? null },
        }),
    );
    return { ...(await this.entryOut(row)), substance: row.substance, reaction: row.reaction };
  }

  async addCondition(
    request: FastifyRequest,
    actor: Actor,
    patientId: string,
    body: CreateConditionBody,
  ): Promise<MedicalCondition> {
    const row = await this.addEntry(
      request,
      actor,
      patientId,
      'conditions',
      body.source,
      (tx, base) =>
        tx.medicalCondition.create({
          data: { ...base, name: body.name, icd10Code: body.icd10Code ?? null },
        }),
    );
    return { ...(await this.entryOut(row)), name: row.name, icd10Code: row.icd10Code };
  }

  async addMedication(
    request: FastifyRequest,
    actor: Actor,
    patientId: string,
    body: CreateMedicationBody,
  ): Promise<CurrentMedication> {
    const row = await this.addEntry(
      request,
      actor,
      patientId,
      'medications',
      body.source,
      (tx, base) =>
        tx.currentMedication.create({
          data: { ...base, name: body.name, dose: body.dose ?? null },
        }),
    );
    return { ...(await this.entryOut(row)), name: row.name, dose: row.dose };
  }

  /** Marks a chart entry removed, keeping it (and who, when and why) for the record. */
  async removeEntry(
    request: FastifyRequest,
    actor: Actor,
    patientId: string,
    kind: ChartKind,
    entryId: string,
    reason: string,
  ): Promise<void> {
    await withTenant(this.s.db, actor.organisationId, async (tx) => {
      const where = { id: entryId, patientId, removedAt: null };
      const data = {
        removedAt: this.s.now(),
        removedByUserId: actor.userId,
        removedReason: reason,
      };
      const { count } =
        kind === 'allergies'
          ? await tx.allergy.updateMany({ where, data })
          : kind === 'conditions'
            ? await tx.medicalCondition.updateMany({ where, data })
            : await tx.currentMedication.updateMany({ where, data });
      if (count === 0) throw NOT_FOUND();
      await this.audit(
        tx,
        request,
        actor,
        `${AUDIT_NAMES[kind]}.removed`,
        AUDIT_NAMES[kind],
        entryId,
        {
          patientId,
          reason,
        },
      );
    });
  }

  // ---- Vitals -----------------------------------------------------------------------

  async vitals(
    request: FastifyRequest,
    actor: Actor,
    appointmentId: string,
  ): Promise<Vitals | null> {
    return withTenant(this.s.db, actor.organisationId, async (tx) => {
      const appointment = await tx.appointment.findUnique({ where: { id: appointmentId } });
      if (!appointment) throw NOT_FOUND();
      const row = await tx.vitals.findUnique({ where: { appointmentId } });
      if (row) await this.audit(tx, request, actor, 'vitals.viewed', 'appointment', appointmentId);
      return row ? this.vitalsOut(row) : null;
    });
  }

  /** Records the whole set: readings left out are cleared, as the form shows every field. */
  async saveVitals(
    request: FastifyRequest,
    actor: Actor,
    appointmentId: string,
    body: VitalsBody,
  ): Promise<Vitals> {
    return withTenant(this.s.db, actor.organisationId, async (tx) => {
      const appointment = await lockVisit(tx, appointmentId);
      if (!VITALS_STATUSES.includes(appointment.status)) {
        throw new AppError(
          409,
          'CONFLICT',
          'Vitals can only be recorded for a visit that is going ahead.',
        );
      }
      const consultation = await tx.consultation.findUnique({ where: { appointmentId } });
      if (consultation?.lockedAt) throw this.locked();
      const readings = {
        bpSystolic: body.bpSystolic ?? null,
        bpDiastolic: body.bpDiastolic ?? null,
        pulse: body.pulse ?? null,
        temperatureC: body.temperatureC ?? null,
        spo2: body.spo2 ?? null,
        weightKg: body.weightKg ?? null,
        heightCm: body.heightCm ?? null,
        painScore: body.painScore ?? null,
        pregnancyStatus: body.pregnancyStatus ?? null,
        recordedByUserId: actor.userId,
      };
      const row = await tx.vitals.upsert({
        where: { appointmentId },
        create: {
          ...readings,
          organisationId: actor.organisationId,
          appointmentId,
          patientId: appointment.patientId,
        },
        update: readings,
      });
      await this.audit(tx, request, actor, 'vitals.saved', 'appointment', appointmentId);
      return this.vitalsOut(row);
    });
  }

  // ---- Consultation -----------------------------------------------------------------

  async consultation(
    request: FastifyRequest,
    actor: Actor,
    appointmentId: string,
  ): Promise<ConsultationView> {
    return withTenant(this.s.db, actor.organisationId, async (tx) => {
      const appointment = await this.appointments.detail(tx, appointmentId);
      const row = await tx.consultation.findUnique({ where: { appointmentId } });
      const vitals = await tx.vitals.findUnique({ where: { appointmentId } });
      await this.audit(tx, request, actor, 'consultation.viewed', 'appointment', appointmentId);
      return {
        appointment,
        consultation: row ? this.recordOut(row) : null,
        vitals: vitals ? await this.vitalsOut(vitals) : null,
        canEdit:
          appointment.doctorUserId === actor.userId &&
          NOTE_STATUSES.includes(appointment.status) &&
          !row?.lockedAt,
      };
    });
  }

  /**
   * Saves the notes if `revision` matches what is stored (0 = first save). A stale tab
   * gets 409 and must reload rather than overwrite newer notes.
   */
  async save(
    request: FastifyRequest,
    actor: Actor,
    appointmentId: string,
    body: SaveConsultationBody,
  ): Promise<ConsultationRecord> {
    return withTenant(this.s.db, actor.organisationId, async (tx) => {
      const appointment = await lockVisit(tx, appointmentId);
      if (appointment.doctorUserId !== actor.userId) {
        throw new AppError(403, 'FORBIDDEN', 'Only the visit’s doctor can write these notes.');
      }
      if (!NOTE_STATUSES.includes(appointment.status)) {
        throw new AppError(
          409,
          'CONFLICT',
          'Notes can be written once the patient has checked in.',
        );
      }
      const existing = await tx.consultation.findUnique({ where: { appointmentId } });
      if (existing?.lockedAt) throw this.locked();
      if ((existing?.revision ?? 0) !== body.revision) {
        throw new AppError(
          409,
          'CONFLICT',
          'These notes were changed somewhere else. Reload to see the latest version.',
          { revision: 'stale' },
        );
      }
      const data = {
        notesCipher: this.s.cipher.encrypt(JSON.stringify(body.notes)),
        followUpDate: body.followUpDate ? toDbDate(body.followUpDate) : null,
      };
      const row = existing
        ? await tx.consultation.update({
            where: { id: existing.id },
            data: { ...data, revision: existing.revision + 1 },
          })
        : await tx.consultation.create({
            data: {
              ...data,
              organisationId: actor.organisationId,
              appointmentId,
              patientId: appointment.patientId,
              doctorUserId: actor.userId,
            },
          });
      await this.audit(tx, request, actor, 'consultation.saved', 'appointment', appointmentId, {
        revision: row.revision,
      });
      return this.recordOut(row);
    });
  }

  // ---- Helpers ----------------------------------------------------------------------

  private async addEntry<T extends { id: string }>(
    request: FastifyRequest,
    actor: Actor,
    patientId: string,
    kind: ChartKind,
    source: ChartSource,
    create: (
      tx: Tx,
      base: {
        organisationId: string;
        patientId: string;
        source: ChartSource;
        recordedByUserId: string;
      },
    ) => Promise<T>,
  ): Promise<T & { source: ChartSource; createdAt: Date; recordedByUserId: string }> {
    return withTenant(this.s.db, actor.organisationId, async (tx) => {
      const patient = await tx.patient.findUnique({
        where: { id: patientId },
        select: { id: true, mergedIntoId: true },
      });
      if (!patient) throw NOT_FOUND();
      assertNotMerged(patient);
      const row = (await create(tx, {
        organisationId: actor.organisationId,
        patientId,
        source,
        recordedByUserId: actor.userId,
      })) as T & { source: ChartSource; createdAt: Date; recordedByUserId: string };
      await this.audit(
        tx,
        request,
        actor,
        `${AUDIT_NAMES[kind]}.added`,
        AUDIT_NAMES[kind],
        row.id,
        {
          patientId,
        },
      );
      return row;
    });
  }

  private async entryOut(row: {
    id: string;
    source: ChartSource;
    createdAt: Date;
    recordedByUserId: string;
  }) {
    const names = await this.names([row.recordedByUserId]);
    return {
      id: row.id,
      source: row.source,
      createdAt: row.createdAt.toISOString(),
      recordedByName: names.get(row.recordedByUserId) ?? null,
    };
  }

  private async vitalsOut(row: Prisma.VitalsGetPayload<object>): Promise<Vitals> {
    const names = await this.names([row.recordedByUserId]);
    const weightKg = num(row.weightKg);
    const heightCm = num(row.heightCm);
    return {
      bpSystolic: row.bpSystolic,
      bpDiastolic: row.bpDiastolic,
      pulse: row.pulse,
      temperatureC: num(row.temperatureC),
      spo2: row.spo2,
      weightKg,
      heightCm,
      painScore: row.painScore,
      pregnancyStatus: row.pregnancyStatus,
      bmi: bmiOf(weightKg, heightCm),
      recordedByName: names.get(row.recordedByUserId) ?? null,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private recordOut(row: Prisma.ConsultationGetPayload<object>): ConsultationRecord {
    return {
      id: row.id,
      doctorUserId: row.doctorUserId,
      notes: this.decrypt(row.notesCipher),
      followUpDate: row.followUpDate ? fromDbDate(row.followUpDate) : null,
      revision: row.revision,
      updatedAt: row.updatedAt.toISOString(),
      lockedAt: row.lockedAt?.toISOString() ?? null,
    };
  }

  private decrypt(cipher: string): ConsultationNotes {
    return ConsultationNotes.parse(JSON.parse(this.s.cipher.decrypt(cipher)));
  }

  private locked() {
    return new AppError(
      409,
      'CONFLICT',
      'The prescription for this visit is signed, so the record can no longer change.',
    );
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

  /** Display names of staff (users are platform-level, outside tenant RLS). */
  private async names(userIds: string[]): Promise<Map<string, string | null>> {
    const ids = [...new Set(userIds)];
    if (ids.length === 0) return new Map();
    const users = await withAuth(this.s.db, (tx) =>
      tx.user.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true } }),
    );
    return new Map(users.map((u) => [u.id, u.displayName]));
  }
}
