import { z } from 'zod';
import { Appointment } from './appointments';

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
