import type { AppointmentStatus, ReferralStatus, Role } from '@dhc/contracts';
import type { Tx } from '@dhc/db';
import { AppError } from '../../errors';
import { historyIds, liveId } from '../patients/merged';
import { readSettings } from '../settings/service';

/** A visit at which the doctor treated the patient: checked in to them, or later. */
const TREATED: AppointmentStatus[] = ['checked_in', 'in_consultation', 'completed'];
/** A referral that still opens the chart to its receiving doctor: not closed. */
export const OPEN_REFERRAL: ReferralStatus[] = ['sent', 'seen'];

/**
 * The organisation's chart model (PRD §3.2). Under `own_patients` a doctor reads a
 * patient's chart, notes and prescriptions only once the patient has been checked in to
 * them, or while an internal referral of the patient to them is open (sent or seen, not
 * closed) and its visit still stands (checked in, in consultation or completed; PRD §7.2);
 * under `shared` (the default) every doctor can. Other roles are
 * already kept out of clinical content by their route's role check. After a merge, a visit
 * or referral of the kept record or of any duplicate merged into it counts, whichever of
 * those records `patientId` names.
 */
export async function assertChartAccess(
  tx: Tx,
  actor: { userId: string; organisationId: string; role: Role },
  patientId: string,
): Promise<void> {
  if (actor.role !== 'doctor') return;
  const { chartModel } = await readSettings(tx, actor.organisationId);
  if (chartModel === 'shared') return;
  const patient = await tx.patient.findUnique({
    where: { id: patientId },
    select: { id: true, mergedIntoId: true },
  });
  const ids = patient ? await historyIds(tx, liveId(patient)) : [patientId];
  const treated = await tx.appointment.count({
    where: { patientId: { in: ids }, doctorUserId: actor.userId, status: { in: TREATED } },
  });
  if (treated > 0) return;
  // Only internal referrals name a receiving doctor; a closed one no longer opens the chart,
  // nor does one from a visit that was cancelled (or otherwise did not happen) afterwards.
  const referred = await tx.referral.count({
    where: {
      patientId: { in: ids },
      receivingDoctorUserId: actor.userId,
      status: { in: OPEN_REFERRAL },
      appointment: { status: { in: TREATED } },
    },
  });
  if (referred > 0) return;
  throw new AppError(
    403,
    'CHART_RESTRICTED',
    'This clinic shares a chart only with the doctors who have seen the patient or received a referral.',
  );
}
