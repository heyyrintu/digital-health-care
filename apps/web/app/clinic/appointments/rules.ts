import type { Appointment, AppointmentAction } from '@dhc/contracts';
import { appointmentActions } from '@dhc/domain';

/** Which buttons to show; shared with the Clinic app and enforced by the API. */
export function actionsFor(
  a: Appointment,
  me: { role: string; userId: string },
  today: string,
  now: Date,
): AppointmentAction[] {
  return appointmentActions(a, me, today, now);
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

/** Front desk and doctors print the visit's signed prescription (after voiding, the VOID copy). */
export const canPrintPrescription = (a: Appointment, role: string) =>
  (role === 'front_desk' || role === 'doctor') && a.prescription !== null;
