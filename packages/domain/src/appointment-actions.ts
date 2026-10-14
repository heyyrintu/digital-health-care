/**
 * Which appointment actions to offer (PRD §3.2, §5.2). The API enforces the same rules;
 * clients use this to show only the buttons that will work. Front desk and doctors check
 * in and mark no-shows; only the patient's own doctor runs the consultation.
 */
export type QueueAction = 'confirm' | 'check_in' | 'start' | 'complete' | 'no_show' | 'cancel';

const RULES: Record<QueueAction, { from: string[]; roles: string[] }> = {
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

export interface ActionableAppointment {
  status: string;
  doctorUserId: string;
  /** IST day, YYYY-MM-DD. */
  date: string;
  startAt: string;
}

export function appointmentActions(
  a: ActionableAppointment,
  me: { role: string; userId: string },
  today: string,
  now: Date,
): QueueAction[] {
  return (Object.keys(RULES) as QueueAction[]).filter((action) => {
    const rule = RULES[action];
    if (!rule.from.includes(a.status) || !rule.roles.includes(me.role)) return false;
    if ((action === 'start' || action === 'complete') && a.doctorUserId !== me.userId) return false;
    if (action === 'check_in' && a.date !== today) return false;
    if (action === 'no_show' && new Date(a.startAt) > now) return false;
    return true;
  });
}
