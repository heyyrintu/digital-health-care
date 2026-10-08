import { DoseStep, type Prescription, type Role, type SafetySummary } from '@dhc/contracts';
import { withAuth, type Db, type Prisma, type Tx } from '@dhc/db';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../errors';
import { writeAudit } from '../audit/write';
import { lockVisit, NOTE_STATUSES } from '../clinical/service';

export interface Actor {
  userId: string;
  organisationId: string;
  role: Role;
}

export const NOT_FOUND = () => new AppError(404, 'NOT_FOUND', 'Not found.');
export const invalid = (field: string, message: string) =>
  new AppError(400, 'VALIDATION_FAILED', message, { [field]: 'invalid' });
export const fromDbDate = (date: Date) => date.toISOString().slice(0, 10);

const Steps = z.array(DoseStep);

export type ItemRow = Prisma.PrescriptionItemGetPayload<object>;
export type PrescriptionRow = Prisma.PrescriptionGetPayload<{ include: { items: true } }>;

export const itemOut = (row: ItemRow) => ({
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

/** The visit's latest version, with its lines. */
export function currentPrescription(
  tx: Tx,
  appointmentId: string,
): Promise<PrescriptionRow | null> {
  return tx.prescription.findFirst({
    where: { appointmentId },
    include: { items: { orderBy: { sortOrder: 'asc' } } },
    orderBy: { version: 'desc' },
  });
}

export const verificationUrl = (webBaseUrl: string, code: string) => `${webBaseUrl}/verify/${code}`;

export function prescriptionOut(
  row: PrescriptionRow,
  safety: SafetySummary,
  webBaseUrl: string,
): Prescription {
  return {
    id: row.id,
    status: row.status,
    version: row.version,
    number: row.number,
    amendmentReason: row.amendmentReason,
    signedAt: row.signedAt?.toISOString() ?? null,
    signatureMethod: (row.signatureMethod as Prescription['signatureMethod']) ?? null,
    verificationUrl: row.verificationCode
      ? verificationUrl(webBaseUrl, row.verificationCode)
      : null,
    supersededAt: row.supersededAt?.toISOString() ?? null,
    voidedAt: row.voidedAt?.toISOString() ?? null,
    voidReason: row.voidReason,
    language: row.language,
    items: row.items.map(itemOut),
    revision: row.revision,
    updatedAt: row.updatedAt.toISOString(),
    safety,
  };
}

/**
 * The visit, locked, if the actor may write its prescription now, and its draft. A draft
 * that amends a signed version stays writable after the visit record locks.
 */
export async function writableVisit(tx: Tx, actor: Actor, appointmentId: string) {
  const appointment = await lockVisit(tx, appointmentId);
  if (appointment.doctorUserId !== actor.userId) {
    throw new AppError(403, 'FORBIDDEN', 'Only the visit’s doctor can write this prescription.');
  }
  if (!NOTE_STATUSES.includes(appointment.status)) {
    throw new AppError(
      409,
      'CONFLICT',
      'A prescription can be written once the patient has checked in.',
    );
  }
  const consultation = await tx.consultation.findUnique({ where: { appointmentId } });
  const existing = await currentPrescription(tx, appointmentId);
  const amending = existing?.status === 'draft' && existing.amendsPrescriptionId !== null;
  if ((consultation?.lockedAt && !amending) || (existing && existing.status !== 'draft')) {
    throw new AppError(
      409,
      'PRESCRIPTION_LOCKED',
      'This prescription is signed and can no longer change. Amend it to make a new version.',
    );
  }
  return { appointment, existing, consultation };
}

export function auditVisit(
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
export async function staffNames(db: Db, userIds: string[]): Promise<Map<string, string | null>> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return new Map();
  const users = await withAuth(db, (tx) =>
    tx.user.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true } }),
  );
  return new Map(users.map((u) => [u.id, u.displayName]));
}
