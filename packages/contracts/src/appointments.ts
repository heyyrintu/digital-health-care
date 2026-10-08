import { z } from 'zod';
import { BillSummary } from './billing';
import { Gender } from './patients';
import { ConsultationMode } from './scheduling';
import { TagRef } from './tags';

/** PRD §5.2: Pending → Confirmed → Checked-in → In consultation → Completed. */
export const AppointmentStatus = z.enum([
  'pending',
  'confirmed',
  'checked_in',
  'in_consultation',
  'completed',
  'cancelled',
  'no_show',
  'rescheduled',
]);
export type AppointmentStatus = z.infer<typeof AppointmentStatus>;

/** Statuses that hold the doctor's time. */
export const ACTIVE_APPOINTMENT_STATUSES = [
  'pending',
  'confirmed',
  'checked_in',
  'in_consultation',
] as const satisfies readonly AppointmentStatus[];

export const AppointmentSource = z.enum(['front_desk', 'walk_in', 'app', 'web']);
export type AppointmentSource = z.infer<typeof AppointmentSource>;

/** Who the appointment is for, as the queue shows it. */
export const AppointmentPatient = z.object({
  id: z.uuid(),
  uhid: z.string(),
  name: z.string(),
  phone: z.string().nullable(),
  dob: z.iso.date().nullable(),
  gender: Gender.nullable(),
  tags: z.array(TagRef),
});
export type AppointmentPatient = z.infer<typeof AppointmentPatient>;

export const Appointment = z.object({
  id: z.uuid(),
  patient: AppointmentPatient,
  doctorUserId: z.uuid(),
  doctorName: z.string().nullable(),
  clinicId: z.uuid(),
  clinicName: z.string(),
  consultationTypeId: z.uuid(),
  consultationTypeName: z.string(),
  mode: ConsultationMode,
  /** IST day the queue and token belong to. */
  date: z.iso.date(),
  startAt: z.iso.datetime(),
  endAt: z.iso.datetime(),
  /** IST wall-clock `HH:MM`. */
  startTime: z.string(),
  status: AppointmentStatus,
  source: AppointmentSource,
  tokenNumber: z.number().int(),
  overbook: z.boolean(),
  reason: z.string().nullable(),
  cancelReason: z.string().nullable(),
  rescheduledFromId: z.uuid().nullable(),
  rescheduledToId: z.uuid().nullable(),
  checkedInAt: z.iso.datetime().nullable(),
  consultationStartedAt: z.iso.datetime().nullable(),
  completedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  /** The visit's bill, once one is made. */
  bill: BillSummary.nullable(),
  /**
   * The visit's current signed prescription (the newest signed or voided version), for
   * printing at the front desk: no clinical content. Null until the doctor signs.
   */
  prescription: z
    .object({
      id: z.uuid(),
      number: z.string(),
      version: z.number().int().min(1),
      status: z.enum(['signed', 'void']),
    })
    .nullable(),
});
export type Appointment = z.infer<typeof Appointment>;

export const AppointmentHistoryEntry = z.object({
  fromStatus: AppointmentStatus.nullable(),
  toStatus: AppointmentStatus,
  actorUserId: z.uuid(),
  actorName: z.string().nullable(),
  note: z.string().nullable(),
  at: z.iso.datetime(),
});
export type AppointmentHistoryEntry = z.infer<typeof AppointmentHistoryEntry>;

export const AppointmentDetail = Appointment.extend({ history: z.array(AppointmentHistoryEntry) });
export type AppointmentDetail = z.infer<typeof AppointmentDetail>;

export const AppointmentList = z.object({ data: z.array(Appointment) });
export type AppointmentList = z.infer<typeof AppointmentList>;

/** A day's appointments (defaults to today, IST), or one patient's (any day). */
export const AppointmentListQuery = z.object({
  date: z.iso.date().optional(),
  doctorId: z.uuid().optional(),
  clinicId: z.uuid().optional(),
  patientId: z.uuid().optional(),
});
export type AppointmentListQuery = z.infer<typeof AppointmentListQuery>;

const reasonText = z.string().trim().min(1).max(300);

/**
 * Book a patient into a slot (`startAt` = a slot's start), or add a walk-in to today's
 * queue (`walkIn`, no `startAt`). `overbook` books into a slot that is already taken,
 * within the clinic's daily limit.
 */
export const CreateAppointmentBody = z.object({
  patientId: z.uuid(),
  doctorUserId: z.uuid(),
  clinicId: z.uuid(),
  consultationTypeId: z.uuid(),
  startAt: z.iso.datetime().optional(),
  walkIn: z.boolean().default(false),
  overbook: z.boolean().default(false),
  reason: reasonText.nullable().optional(),
});
export type CreateAppointmentBody = z.infer<typeof CreateAppointmentBody>;

/** Moves to a new slot: the old appointment becomes `rescheduled`, linked to the new one. */
export const RescheduleAppointmentBody = z.object({
  startAt: z.iso.datetime(),
  /** Defaults to the current doctor, clinic and type. */
  doctorUserId: z.uuid().optional(),
  clinicId: z.uuid().optional(),
  consultationTypeId: z.uuid().optional(),
  overbook: z.boolean().default(false),
});
export type RescheduleAppointmentBody = z.infer<typeof RescheduleAppointmentBody>;

/** Status changes staff make directly; rescheduling has its own endpoint. */
export const AppointmentAction = z.enum([
  'confirm',
  'check_in',
  'start',
  'complete',
  'cancel',
  'no_show',
]);
export type AppointmentAction = z.infer<typeof AppointmentAction>;

export const AppointmentActionBody = z.object({
  action: AppointmentAction,
  /** Required to cancel. */
  reason: reasonText.nullable().optional(),
});
export type AppointmentActionBody = z.infer<typeof AppointmentActionBody>;
