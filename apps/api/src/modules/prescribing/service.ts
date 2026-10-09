import {
  TemplateItem,
  type LastPrescription,
  type Medicine,
  type Prescription,
  type PrescriptionTemplate,
  type PrescriptionView,
  type SafetyActionBody,
  type SafetySummary,
  type SavePrescriptionBody,
  type SaveTemplateBody,
} from '@dhc/contracts';
import { Prisma, withTenant, type Tx } from '@dhc/db';
import { dosageRemarks } from '@dhc/domain';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../errors';
import type { Services } from '../../services';
import { writeAudit } from '../audit/write';
import { lockVisit, NOTE_STATUSES } from '../clinical/service';
import { historyIds, liveId } from '../patients/merged';
import { findProfile, signingGaps } from '../doctors/service';
import { checkAndRecord, summarise, type SafetyVisit } from './safety';
import {
  auditVisit,
  currentPrescription,
  fromDbDate,
  invalid,
  itemOut,
  NOT_FOUND,
  prescriptionOut,
  staffNames,
  writableVisit,
  type Actor,
  type PrescriptionRow,
} from './shared';

const TemplateItems = z.array(TemplateItem);

const withoutId = ({ id: _id, ...line }: ReturnType<typeof itemOut>) => line;

/** Medicines must be active and in the master this clinic can see (the platform's or its own). */
async function checkMedicines(tx: Tx, items: { medicineId: string | null }[]): Promise<void> {
  const ids = [...new Set(items.flatMap((i) => (i.medicineId ? [i.medicineId] : [])))];
  if (ids.length === 0) return;
  const found = await tx.medicine.count({ where: { id: { in: ids }, active: true } });
  if (found !== ids.length) throw invalid('items', 'A medicine is not in the list.');
}

/**
 * The prescription builder (PRD §6.4): medicine search, a visit's draft lines with
 * dosage remarks, templates and "repeat last", checked by the safety engine (PRD §6.5)
 * on every save. Doctors only; only the visit's doctor writes. Signing and the PDF follow
 * in a later slice.
 */
export class PrescribingService {
  constructor(private readonly s: Services) {}

  async searchMedicines(actor: Actor, q: string): Promise<Medicine[]> {
    const rows = await withTenant(this.s.db, actor.organisationId, (tx) =>
      tx.medicine.findMany({
        where: {
          active: true,
          OR: [
            { name: { contains: q, mode: 'insensitive' } },
            { genericName: { contains: q, mode: 'insensitive' } },
            { composition: { contains: q, mode: 'insensitive' } },
            // The names doctors typed before the clinic admin mapped them to this medicine.
            {
              requests: {
                some: { decision: 'approved', name: { contains: q, mode: 'insensitive' } },
              },
            },
          ],
        },
        orderBy: [{ name: 'asc' }],
        take: 20,
      }),
    );
    return rows.map((m) => ({
      id: m.id,
      name: m.name,
      genericName: m.genericName,
      composition: m.composition,
      form: m.form,
      defaultRoute: m.defaultRoute,
      source: m.source,
    }));
  }

  async view(
    request: FastifyRequest,
    actor: Actor,
    appointmentId: string,
  ): Promise<PrescriptionView> {
    return withTenant(this.s.db, actor.organisationId, async (tx) => {
      const appointment = await tx.appointment.findUnique({
        where: { id: appointmentId },
        include: { patient: { select: { language: true } }, consultation: true },
      });
      if (!appointment) throw NOT_FOUND();
      const row = await currentPrescription(tx, appointmentId);
      await auditVisit(tx, request, actor, 'prescription.viewed', appointmentId);
      // The chart may have changed since the last save (a new allergy, today's weight), so
      // a draft is checked again on opening.
      // Only the visit's doctor writes to the safety log; others see the check without it.
      // Writing takes the visit lock, like a save, so two openings cannot race.
      const persist = row?.status === 'draft' && appointment.doctorUserId === actor.userId;
      if (persist) await lockVisit(tx, appointmentId);
      const safety = row ? await this.safety(tx, actor, appointment, row, persist) : null;
      const ownVisit = appointment.doctorUserId === actor.userId;
      const amending = row?.status === 'draft' && row.amendsPrescriptionId !== null;
      const versions = await tx.prescription.findMany({
        where: { appointmentId },
        select: { id: true, version: true, status: true, number: true, signedAt: true },
        orderBy: { version: 'desc' },
      });
      return {
        prescription: row && safety ? prescriptionOut(row, safety, this.s.webBaseUrl) : null,
        defaultLanguage: appointment.patient.language,
        canEdit:
          ownVisit &&
          NOTE_STATUSES.includes(appointment.status) &&
          (!appointment.consultation?.lockedAt || amending) &&
          (row?.status ?? 'draft') === 'draft',
        signingMissing: ownVisit
          ? signingGaps(await findProfile(tx, actor), this.s.signer !== null)
          : [],
        canAmend: ownVisit && row?.status === 'signed',
        versions: versions.map((v) => ({
          ...v,
          signedAt: v.signedAt?.toISOString() ?? null,
        })),
      };
    });
  }

  /**
   * Replaces the draft's lines if `revision` matches (0 = first save). Remarks are
   * written by the server for every line the doctor has not edited by hand.
   */
  async save(
    request: FastifyRequest,
    actor: Actor,
    appointmentId: string,
    body: SavePrescriptionBody,
  ): Promise<Prescription> {
    const ids = body.items.map((i) => i.id);
    if (new Set(ids).size !== ids.length) throw invalid('items', 'Each line needs its own ID.');

    return withTenant(this.s.db, actor.organisationId, async (tx) => {
      const { appointment, existing } = await writableVisit(tx, actor, appointmentId);
      if ((existing?.revision ?? 0) !== body.revision) {
        throw new AppError(
          409,
          'CONFLICT',
          'This prescription was changed somewhere else. Reload to see the latest version.',
          { revision: 'stale' },
        );
      }

      await checkMedicines(tx, body.items);

      const prescription = existing
        ? await tx.prescription.update({
            where: { id: existing.id },
            data: { language: body.language, revision: existing.revision + 1 },
          })
        : await tx.prescription.create({
            data: {
              organisationId: actor.organisationId,
              appointmentId,
              patientId: appointment.patientId,
              doctorUserId: actor.userId,
              language: body.language,
            },
          });
      await tx.prescriptionItem.deleteMany({ where: { prescriptionId: prescription.id } });
      try {
        await tx.prescriptionItem.createMany({
          data: body.items.map((item, sortOrder) => ({
            ...item,
            steps: item.steps,
            remarks: item.remarksEdited
              ? item.remarks
              : dosageRemarks(
                  { steps: item.steps, timing: item.timing, route: item.route },
                  body.language,
                ),
            organisationId: actor.organisationId,
            prescriptionId: prescription.id,
            sortOrder,
          })),
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          throw invalid('items', 'A line ID is already in use.');
        }
        throw error;
      }
      const saved = (await currentPrescription(tx, appointmentId))!;
      const safety = await this.safety(tx, actor, appointment, saved, true);
      await auditVisit(tx, request, actor, 'prescription.saved', appointmentId, {
        revision: prescription.revision,
        lines: body.items.length,
        openBlocks: safety.openBlocks,
        openWarnings: safety.openWarnings,
      });
      return prescriptionOut(saved, safety, this.s.webBaseUrl);
    });
  }

  /**
   * Records the doctor's answer to an alert that is firing now: `acknowledge` a warning
   * (with a reason when the rule needs one) or `override` a block the drug database
   * allows overriding (always with a reason). Blocks it does not allow must be fixed.
   */
  async act(
    request: FastifyRequest,
    actor: Actor,
    appointmentId: string,
    body: SafetyActionBody,
  ): Promise<SafetySummary> {
    return withTenant(this.s.db, actor.organisationId, async (tx) => {
      const { appointment, existing } = await writableVisit(tx, actor, appointmentId);
      if (!existing) throw NOT_FOUND();
      const { findings, summary } = await this.check(tx, actor, appointment, existing, true);
      const finding = findings.find((f) => f.key === body.key);
      if (!finding) {
        throw new AppError(409, 'CONFLICT', 'This alert no longer applies.', { key: 'resolved' });
      }
      const reason = body.reason?.trim() || null;
      if (body.action === 'acknowledge' && finding.severity !== 'warn') {
        throw invalid('action', 'Only warnings are acknowledged.');
      }
      if (body.action === 'override' && !(finding.severity === 'block' && finding.overridable)) {
        throw invalid('action', 'This alert cannot be overridden; change the prescription.');
      }
      if ((finding.reasonRequired || body.action === 'override') && !reason) {
        throw invalid('reason', 'Give a reason.');
      }
      const action = body.action === 'acknowledge' ? 'acknowledged' : 'overridden';
      const row = await tx.safetyAlert.update({
        where: { prescriptionId_key: { prescriptionId: existing.id, key: body.key } },
        data: { action, reason, actionByUserId: actor.userId, actionAt: this.s.now() },
      });
      await auditVisit(tx, request, actor, `prescription.safety_${action}`, appointmentId, {
        alertId: row.id,
        ruleId: finding.ruleId,
        drugDatabaseVersion: row.drugDatabaseVersion,
      });
      const rows = await tx.safetyAlert.findMany({ where: { prescriptionId: existing.id } });
      return summarise(findings, new Map(rows.map((r) => [r.key, r])), summary.drugDatabaseVersion);
    });
  }

  /**
   * The patient's latest prescription with lines, for "Repeat last": from visits before
   * `before` when given (the visit being written), otherwise from any visit.
   */
  async last(
    request: FastifyRequest,
    actor: Actor,
    patientId: string,
    before?: string,
  ): Promise<LastPrescription['last']> {
    const row = await withTenant(this.s.db, actor.organisationId, async (tx) => {
      const patient = await tx.patient.findUnique({
        where: { id: patientId },
        select: { id: true, mergedIntoId: true },
      });
      if (!patient) throw NOT_FOUND();
      // Prescriptions from duplicates merged into the record count as its own.
      const ids = await historyIds(tx, liveId(patient));
      // "Last" is relative to the visit being written: from an older visit, a later
      // visit's prescription must not be offered.
      const current = before
        ? await tx.appointment.findFirst({
            where: { id: before, patientId: { in: ids } },
            select: { startAt: true },
          })
        : null;
      if (before && !current) throw NOT_FOUND();
      const found = await tx.prescription.findFirst({
        where: {
          patientId: { in: ids },
          status: { not: 'void' },
          items: { some: {} },
          ...(current
            ? { appointmentId: { not: before }, appointment: { startAt: { lt: current.startAt } } }
            : {}),
        },
        include: {
          items: { orderBy: { sortOrder: 'asc' } },
          appointment: { select: { date: true, startAt: true } },
        },
        orderBy: { appointment: { startAt: 'desc' } },
      });
      await writeAudit(tx, request, {
        action: 'prescription.last_viewed',
        organisationId: actor.organisationId,
        actorUserId: actor.userId,
        entityType: 'patient',
        entityId: patientId,
      });
      return found;
    });
    if (!row) return null;
    const names = await staffNames(this.s.db, [row.doctorUserId]);
    return {
      appointmentId: row.appointmentId,
      date: fromDbDate(row.appointment.date),
      doctorName: names.get(row.doctorUserId) ?? null,
      items: row.items.map((i) => withoutId(itemOut(i))),
    };
  }

  async templates(actor: Actor): Promise<PrescriptionTemplate[]> {
    const rows = await withTenant(this.s.db, actor.organisationId, (tx) =>
      tx.prescriptionTemplate.findMany({
        where: { doctorUserId: actor.userId },
        orderBy: { name: 'asc' },
      }),
    );
    return rows.map((t) => this.templateOut(t));
  }

  async saveTemplate(
    request: FastifyRequest,
    actor: Actor,
    body: SaveTemplateBody,
  ): Promise<PrescriptionTemplate> {
    return withTenant(this.s.db, actor.organisationId, async (tx) => {
      await checkMedicines(tx, body.items);
      const row = await tx.prescriptionTemplate.upsert({
        where: {
          organisationId_doctorUserId_name: {
            organisationId: actor.organisationId,
            doctorUserId: actor.userId,
            name: body.name,
          },
        },
        create: {
          organisationId: actor.organisationId,
          doctorUserId: actor.userId,
          name: body.name,
          items: body.items,
        },
        update: { items: body.items },
      });
      await writeAudit(tx, request, {
        action: 'prescription_template.saved',
        organisationId: actor.organisationId,
        actorUserId: actor.userId,
        entityType: 'prescription_template',
        entityId: row.id,
        metadata: { lines: body.items.length },
      });
      return this.templateOut(row);
    });
  }

  async deleteTemplate(request: FastifyRequest, actor: Actor, id: string): Promise<void> {
    await withTenant(this.s.db, actor.organisationId, async (tx) => {
      const { count } = await tx.prescriptionTemplate.deleteMany({
        where: { id, doctorUserId: actor.userId },
      });
      if (count === 0) throw NOT_FOUND();
      await writeAudit(tx, request, {
        action: 'prescription_template.deleted',
        organisationId: actor.organisationId,
        actorUserId: actor.userId,
        entityType: 'prescription_template',
        entityId: id,
      });
    });
  }

  // ---- Helpers ----------------------------------------------------------------------

  private check(tx: Tx, actor: Actor, visit: SafetyVisit, row: PrescriptionRow, persist: boolean) {
    return checkAndRecord(tx, {
      visit,
      prescriptionId: row.id,
      organisationId: actor.organisationId,
      actorUserId: actor.userId,
      items: row.items,
      persist,
      now: this.s.now(),
    });
  }

  private async safety(
    tx: Tx,
    actor: Actor,
    visit: SafetyVisit,
    row: PrescriptionRow,
    persist: boolean,
  ): Promise<SafetySummary> {
    return (await this.check(tx, actor, visit, row, persist)).summary;
  }

  private templateOut(row: Prisma.PrescriptionTemplateGetPayload<object>): PrescriptionTemplate {
    return {
      id: row.id,
      name: row.name,
      items: TemplateItems.parse(row.items),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
