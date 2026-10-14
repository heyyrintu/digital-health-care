import { z } from 'zod';
import { Appointment, AppointmentStatus } from './appointments';
import { PatientSummary } from './patients';

/**
 * A patient due back on the day (PRD §5.1 Follow-ups): the visit whose notes set this
 * follow-up date, and the booking made for it, if any.
 */
export const FollowUp = z.object({
  /** The earlier visit that asked for the follow-up. */
  visitAppointmentId: z.uuid(),
  visitDate: z.iso.date(),
  followUpDate: z.iso.date(),
  patient: PatientSummary,
  doctorUserId: z.uuid(),
  doctorName: z.string().nullable(),
  clinicId: z.uuid(),
  /** A later booking with the same doctor that is still going ahead, or done. */
  booking: z
    .object({
      id: z.uuid(),
      date: z.iso.date(),
      startTime: z.string(),
      status: AppointmentStatus,
    })
    .nullable(),
});
export type FollowUp = z.infer<typeof FollowUp>;

/**
 * One day's queue (PRD §5.1), grouped as the tabs show it:
 * - `myOpd`: in consultation first, then checked in — priority-tagged patients first,
 *   then in order of arrival;
 * - `booked`: not arrived yet (pending shows "Awaiting response"), by time;
 * - `completed`: most recent first;
 * - `closed`: cancelled, no-show and rescheduled, by time.
 */
export const QueueResponse = z.object({
  date: z.iso.date(),
  myOpd: z.array(Appointment),
  booked: z.array(Appointment),
  completed: z.array(Appointment),
  closed: z.array(Appointment),
  /** Patients due back on this day, booked or not (not counted in the other tabs). */
  followUps: z.array(FollowUp),
  /** Mean minutes from start to completion of the day's consultations, when any. */
  averageConsultationMinutes: z.number().nullable(),
});
export type QueueResponse = z.infer<typeof QueueResponse>;

export const QueueQuery = z.object({
  /** Defaults to today (IST). */
  date: z.iso.date().optional(),
  doctorId: z.uuid().optional(),
  clinicId: z.uuid().optional(),
});
export type QueueQuery = z.infer<typeof QueueQuery>;

// ---- Waiting-room screens (PRD §5.3) -------------------------------------------------

export const DisplayScreen = z.object({
  id: z.uuid(),
  clinicId: z.uuid(),
  clinicName: z.string(),
  label: z.string(),
  createdAt: z.iso.datetime(),
});
export type DisplayScreen = z.infer<typeof DisplayScreen>;

export const DisplayScreenList = z.object({ data: z.array(DisplayScreen) });
export type DisplayScreenList = z.infer<typeof DisplayScreenList>;

export const CreateDisplayScreenBody = z.object({
  clinicId: z.uuid(),
  label: z.string().trim().min(1).max(60),
});
export type CreateDisplayScreenBody = z.infer<typeof CreateDisplayScreenBody>;

/** The link is shown once; only its hash is stored. */
export const CreatedDisplayScreen = DisplayScreen.extend({ link: z.url() });
export type CreatedDisplayScreen = z.infer<typeof CreatedDisplayScreen>;

export const DisplayTokenBody = z.object({ token: z.string().min(20).max(200) });
export type DisplayTokenBody = z.infer<typeof DisplayTokenBody>;

/** What a waiting-room screen shows: tokens only, never patient names. */
export const DisplayBoard = z.object({
  clinicName: z.string(),
  date: z.iso.date(),
  doctors: z.array(
    z.object({
      doctorName: z.string().nullable(),
      nowServing: z.number().int().nullable(),
      next: z.array(z.number().int()),
    }),
  ),
});
export type DisplayBoard = z.infer<typeof DisplayBoard>;
