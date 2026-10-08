import type { Appointment, AppointmentAction, AppointmentStatus } from '@dhc/contracts';

/**
 * Which buttons to show; the API enforces the same rules (PRD §3.2, §5.2). Front desk
 * and doctors check in and mark no-shows; only the patient's own doctor runs the
 * consultation.
 */
const RULES: Record<AppointmentAction, { from: AppointmentStatus[]; roles: string[] }> = {
  confirm: { from: ['pending'], roles: ['front_desk', 'doctor', 'clinic_admin'] },
  check_in: { from: ['pending', 'confirmed'], roles: ['front_desk', 'doctor'] },
  start: { from: ['checked_in'], roles: ['doctor'] },
  complete: { from: ['in_consultation'], roles: ['doctor'] },
  no_show: { from: ['pending', 'confirmed'], roles: ['front_desk', 'doctor'] },
  cancel: {
    from: ['pending', 'confirmed', 'checked_in'],
    roles: ['front_desk', 'doctor', 'clinic_admin'],
  },
};

export function actionsFor(
  a: Appointment,
  me: { role: string; userId: string },
  today: string,
  now: Date,
): AppointmentAction[] {
  return (Object.keys(RULES) as AppointmentAction[]).filter((action) => {
    const rule = RULES[action];
    if (!rule.from.includes(a.status) || !rule.roles.includes(me.role)) return false;
    if ((action === 'start' || action === 'complete') && a.doctorUserId !== me.userId) return false;
    if (action === 'check_in' && a.date !== today) return false;
    if (action === 'no_show' && new Date(a.startAt) > now) return false;
    return true;
  });
}

export const canReschedule = (a: Appointment, role: string) =>
  (a.status === 'pending' || a.status === 'confirmed') &&
  ['front_desk', 'doctor', 'clinic_admin'].includes(role);

/** Doctors open the consultation screen once the patient has arrived (PRD §6.1). */
export const canConsult = (a: Appointment, role: string) =>
  role === 'doctor' && ['checked_in', 'in_consultation', 'completed'].includes(a.status);

/** Front desk takes vitals for today's visits that are going ahead; doctors do it in the consultation. */
export const canRecordVitals = (a: Appointment, role: string, today: string) =>
  role === 'front_desk' &&
  a.date === today &&
  ['pending', 'confirmed', 'checked_in', 'in_consultation'].includes(a.status);

/**
 * The bill screen (PRD §5.6): front desk and doctors bill visits whose patient has
 * arrived; clinic admins open a bill once one exists.
 */
export const canBill = (a: Appointment, role: string) =>
  ((role === 'front_desk' || role === 'doctor') &&
    ['checked_in', 'in_consultation', 'completed'].includes(a.status)) ||
  (role === 'clinic_admin' && a.bill !== null);
