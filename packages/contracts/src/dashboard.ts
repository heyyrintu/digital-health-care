import { z } from 'zod';

/** Longest range the dashboard reports on at once, in days. */
export const MAX_DASHBOARD_DAYS = 92;

const DAY_MS = 24 * 60 * 60 * 1000;

export const DashboardQuery = z
  .object({
    /** First IST day, inclusive. Defaults to six days before `to`. */
    from: z.iso.date().optional(),
    /** Last IST day, inclusive. Defaults to today. */
    to: z.iso.date().optional(),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, {
    message: 'The start date must be on or before the end date.',
    path: ['from'],
  })
  .refine(
    (q) =>
      !q.from || !q.to || (Date.parse(q.to) - Date.parse(q.from)) / DAY_MS < MAX_DASHBOARD_DAYS,
    { message: `Pick at most ${MAX_DASHBOARD_DAYS} days.`, path: ['from'] },
  );
export type DashboardQuery = z.infer<typeof DashboardQuery>;

const Count = z.number().int().min(0);

export const DashboardDay = z.object({
  date: z.iso.date(),
  appointments: Count,
  completed: Count,
  cancelled: Count,
  noShows: Count,
  collectionsPaise: Count,
});
export type DashboardDay = z.infer<typeof DashboardDay>;

/**
 * A clinic's figures for a range of IST days (PRD §9.2): visits by their date, patients
 * registered, prescriptions first signed and payments received in the range.
 */
export const DashboardReport = z.object({
  from: z.iso.date(),
  to: z.iso.date(),
  newPatients: Count,
  /** Every visit on the range's days except those moved to another slot. */
  appointments: Count,
  completed: Count,
  cancelled: Count,
  noShows: Count,
  /** No-shows over visits that reached an outcome (completed or no-show); null when none. */
  noShowRate: z.number().min(0).max(1).nullable(),
  /** Prescriptions signed for the first time (amendments and voided ones excluded). */
  prescriptions: Count,
  collectionsPaise: Count,
  byDay: z.array(DashboardDay),
});
export type DashboardReport = z.infer<typeof DashboardReport>;
