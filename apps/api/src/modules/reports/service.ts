import {
  MAX_DASHBOARD_DAYS,
  type DashboardDay,
  type DashboardQuery,
  type DashboardReport,
} from '@dhc/contracts';
import { withTenant } from '@dhc/db';
import { addDays, istDateKey } from '@dhc/domain';
import { AppError } from '../../errors';
import type { Services } from '../../services';

/** Midnight IST at the start of a day, as an instant (IST is UTC+05:30 all year). */
const istMidnight = (day: string) => new Date(`${day}T00:00:00.000+05:30`);

/**
 * The clinic admin's figures (PRD §9.2). Counts are made in the database and read
 * through row-level security, with the organisation also named in every query.
 */
export class ReportsService {
  constructor(private readonly s: Services) {}

  async dashboard(organisationId: string, query: DashboardQuery): Promise<DashboardReport> {
    const to = query.to ?? istDateKey(this.s.now());
    const from = query.from ?? addDays(to, -6);
    // The query checks a range it is given in full; a default end can still break it.
    if (from > to || addDays(from, MAX_DASHBOARD_DAYS) <= to) {
      throw new AppError(
        400,
        'VALIDATION_FAILED',
        `Pick a start on or before the end, at most ${MAX_DASHBOARD_DAYS} days in all.`,
        { from: 'invalid' },
      );
    }
    const start = istMidnight(from);
    const end = istMidnight(addDays(to, 1));

    // One query at a time: they share the tenant transaction.
    const { visits, payments, newPatients, prescriptions } = await withTenant(
      this.s.db,
      organisationId,
      async (tx) => {
        const visits = await tx.$queryRaw<
          {
            day: string;
            appointments: number;
            completed: number;
            cancelled: number;
            noShows: number;
          }[]
        >`
          SELECT to_char(date, 'YYYY-MM-DD') AS day,
                 count(*) FILTER (WHERE status <> 'rescheduled')::int AS appointments,
                 count(*) FILTER (WHERE status = 'completed')::int AS completed,
                 count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
                 count(*) FILTER (WHERE status = 'no_show')::int AS "noShows"
          FROM appointments
          WHERE organisation_id = ${organisationId}::uuid
            AND date BETWEEN ${from}::date AND ${to}::date
          GROUP BY date`;
        const payments = await tx.$queryRaw<{ day: string; paise: number }[]>`
          SELECT to_char(received_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS day,
                 sum(amount_paise)::int AS paise
          FROM payments
          WHERE organisation_id = ${organisationId}::uuid
            AND received_at >= ${start} AND received_at < ${end}
          GROUP BY 1`;
        const newPatients = await tx.patient.count({
          where: { organisationId, createdAt: { gte: start, lt: end } },
        });
        const prescriptions = await tx.prescription.count({
          where: {
            organisationId,
            signedAt: { gte: start, lt: end },
            amendsPrescriptionId: null,
            voidedAt: null,
          },
        });
        return { visits, payments, newPatients, prescriptions };
      },
    );

    const visitsOn = new Map(visits.map((v) => [v.day, v]));
    const paidOn = new Map(payments.map((p) => [p.day, p.paise]));
    const byDay: DashboardDay[] = [];
    for (let day = from; day <= to; day = addDays(day, 1)) {
      const v = visitsOn.get(day);
      byDay.push({
        date: day,
        appointments: v?.appointments ?? 0,
        completed: v?.completed ?? 0,
        cancelled: v?.cancelled ?? 0,
        noShows: v?.noShows ?? 0,
        collectionsPaise: paidOn.get(day) ?? 0,
      });
    }
    const sum = (key: keyof Omit<DashboardDay, 'date'>) =>
      byDay.reduce((total, d) => total + d[key], 0);
    const completed = sum('completed');
    const noShows = sum('noShows');
    return {
      from,
      to,
      newPatients,
      appointments: sum('appointments'),
      completed,
      cancelled: sum('cancelled'),
      noShows,
      noShowRate: completed + noShows > 0 ? noShows / (completed + noShows) : null,
      prescriptions,
      collectionsPaise: sum('collectionsPaise'),
      byDay,
    };
  }
}
