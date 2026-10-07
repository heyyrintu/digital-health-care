import {
  DoseStep,
  TemplateItem,
  type LastPrescription,
  type Medicine,
  type Prescription,
  type PrescriptionTemplate,
  type PrescriptionView,
  type Role,
  type SavePrescriptionBody,
  type SaveTemplateBody,
} from '@dhc/contracts';
import { Prisma, withAuth, withTenant, type Tx } from '@dhc/db';
import { dosageRemarks } from '@dhc/domain';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../errors';
import type { Services } from '../../services';
import { writeAudit } from '../audit/write';
import { lockVisit, NOTE_STATUSES } from '../clinical/service';

interface Actor {
  userId: string;
  organisationId: string;
  role: Role;
}

const NOT_FOUND = () => new AppError(404, 'NOT_FOUND', 'Not found.');
const invalid = (field: string, message: string) =>
  new AppError(400, 'VALIDATION_FAILED', message, { [field]: 'invalid' });
const fromDbDate = (date: Date) => date.toISOString().slice(0, 10);

const Steps = z.array(DoseStep);
const TemplateItems = z.array(TemplateItem);

type ItemRow = Prisma.PrescriptionItemGetPayload<object>;
type PrescriptionRow = Prisma.PrescriptionGetPayload<{ include: { items: true } }>;

const itemOut = (row: ItemRow) => ({
  id: row.id,
  medicineId: row.medicineId,
  name: row.name,
  composition: row.composition,
  form: row.form,
  route: row.route,
  timing: row.timing,
  steps: Steps.parse(row.steps),
  quantity: row.quantity,
  instructions: row.instructions,
  remarks: row.remarks,
  remarksEdited: row.remarksEdited,
});

const withoutId = ({ id: _id, ...line }: ReturnType<typeof itemOut>) => line;

/**
 * The prescription builder (PRD §6.4): medicine search, a visit's draft lines with
 * dosage remarks, templates and "repeat last". Doctors only; only the visit's doctor
 * writes. Signing, the safety engine and the PDF follow in later slices.
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
      const row = await this.current(tx, appointmentId);
      await this.audit(tx, request, actor, 'prescription.viewed', appointmentId);
      return {
        prescription: row ? this.out(row) : null,
        defaultLanguage: appointment.patient.language,
        canEdit:
          appointment.doctorUserId === actor.userId &&
          NOTE_STATUSES.includes(appointment.status) &&
          !appointment.consultation?.lockedAt &&
          (row?.status ?? 'draft') === 'draft',
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
      const appointment = await lockVisit(tx, appointmentId);
      if (appointment.doctorUserId !== actor.userId) {
        throw new AppError(
          403,
          'FORBIDDEN',
          'Only the visit’s doctor can write this prescription.',
        );
      }
      if (!NOTE_STATUSES.includes(appointment.status)) {
        throw new AppError(
          409,
          'CONFLICT',
          'A prescription can be written once the patient has checked in.',
        );
      }
      const consultation = await tx.consultation.findUnique({ where: { appointmentId } });
      const existing = await this.current(tx, appointmentId);
      if (consultation?.lockedAt || (existing && existing.status !== 'draft')) {
        throw new AppError(
          409,
          'CONFLICT',
          'This prescription is signed and can no longer change.',
        );
      }
      if ((existing?.revision ?? 0) !== body.revision) {
        throw new AppError(
          409,
          'CONFLICT',
          'This prescription was changed somewhere else. Reload to see the latest version.',
          { revision: 'stale' },
        );
      }

      // Medicines must be in the master this clinic can see (the platform's or its own).
      const medicineIds = [
        ...new Set(body.items.flatMap((i) => (i.medicineId ? [i.medicineId] : []))),
      ];
      if (medicineIds.length > 0) {
        const found = await tx.medicine.count({ where: { id: { in: medicineIds } } });
        if (found !== medicineIds.length) throw invalid('items', 'A medicine is not in the list.');
      }

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
      await this.audit(tx, request, actor, 'prescription.saved', appointmentId, {
        revision: prescription.revision,
        lines: body.items.length,
      });
      return this.out((await this.current(tx, appointmentId))!);
    });
  }

  /** The patient's latest prescription with lines from another visit, for "Repeat last". */
  async last(
    request: FastifyRequest,
    actor: Actor,
    patientId: string,
    before?: string,
  ): Promise<LastPrescription['last']> {
    const row = await withTenant(this.s.db, actor.organisationId, async (tx) => {
      const patient = await tx.patient.findUnique({
        where: { id: patientId },
        select: { id: true },
      });
      if (!patient) throw NOT_FOUND();
      const found = await tx.prescription.findFirst({
        where: {
          patientId,
          status: { not: 'void' },
          items: { some: {} },
          ...(before ? { appointmentId: { not: before } } : {}),
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
    const names = await this.names([row.doctorUserId]);
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

  private current(tx: Tx, appointmentId: string): Promise<PrescriptionRow | null> {
    return tx.prescription.findFirst({
      where: { appointmentId },
      include: { items: { orderBy: { sortOrder: 'asc' } } },
      orderBy: { version: 'desc' },
    });
  }

  private out(row: PrescriptionRow): Prescription {
    return {
      id: row.id,
      status: row.status,
      language: row.language,
      items: row.items.map(itemOut),
      revision: row.revision,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private templateOut(row: Prisma.PrescriptionTemplateGetPayload<object>): PrescriptionTemplate {
    return {
      id: row.id,
      name: row.name,
      items: TemplateItems.parse(row.items),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private audit(
    tx: Tx,
    request: FastifyRequest,
    actor: Actor,
    action: string,
    appointmentId: string,
    metadata?: Prisma.InputJsonValue,
  ) {
    return writeAudit(tx, request, {
      action,
      organisationId: actor.organisationId,
      actorUserId: actor.userId,
      entityType: 'appointment',
      entityId: appointmentId,
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
