import type { AppointmentStatus, Role } from '@dhc/contracts';
import type { Tx } from '@dhc/db';
import { AppError } from '../../errors';
import { readSettings } from '../settings/service';

/** A visit at which the doctor treated the patient: checked in to them, or later. */
const TREATED: AppointmentStatus[] = ['checked_in', 'in_consultation', 'completed'];

/**
 * The organisation's chart model (PRD §3.2). Under `own_patients` a doctor reads a
 * patient's chart, notes and prescriptions only once the patient has been checked in to
 * them; under `shared` (the default) every doctor can. Other roles are already kept out
 * of clinical content by their route's role check. Internal referrals add access in
 * phase 3.
 */
export async function assertChartAccess(
  tx: Tx,
  actor: { userId: string; organisationId: string; role: Role },
  patientId: string,
): Promise<void> {
  if (actor.role !== 'doctor') return;
  const { chartModel } = await readSettings(tx, actor.organisationId);
  if (chartModel === 'shared') return;
  const treated = await tx.appointment.count({
    where: { patientId, doctorUserId: actor.userId, status: { in: TREATED } },
  });
  if (treated === 0) {
    throw new AppError(
      403,
      'CHART_RESTRICTED',
      'This clinic shares a chart only with the doctors who have seen the patient.',
    );
  }
}
