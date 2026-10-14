import type { Tx } from '@dhc/db';
import { AppError } from '../../errors';

// A merged record is read-only; its history shows under the record it was merged into.
// Merges are flattened (a record merged into a duplicate moves with it), so a merged
// record always points straight at a live one.

/** 409 for writes to a merged record; `fields.patientId` is the record to use instead. */
export const mergedError = (targetId: string) =>
  new AppError(409, 'PATIENT_MERGED', 'This record was merged into another one. Use that record.', {
    patientId: targetId,
  });

export function assertNotMerged(patient: { mergedIntoId: string | null }) {
  if (patient.mergedIntoId) throw mergedError(patient.mergedIntoId);
}

/** The live record for a patient: itself, or the record it was merged into. */
export const liveId = (patient: { id: string; mergedIntoId: string | null }) =>
  patient.mergedIntoId ?? patient.id;

/** A record and the duplicates merged into it: whose visits and prescriptions count as its own. */
export async function historyIds(tx: Tx, patientId: string): Promise<string[]> {
  const merged = await tx.patient.findMany({
    where: { mergedIntoId: patientId },
    select: { id: true },
  });
  return [patientId, ...merged.map((m) => m.id)];
}
