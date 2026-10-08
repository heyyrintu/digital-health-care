'use client';

import { ApiError } from '@dhc/api-client';
import { DashboardReport } from '@dhc/contracts';
import { addDays, formatInr, istDateKey } from '@dhc/domain';
import { Button, Stat } from '@dhc/ui-web';
import {
  CalendarCheck,
  CalendarDays,
  CalendarX,
  FileSignature,
  IndianRupee,
  UserPlus,
  UserX,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSession } from './session-provider';

const RANGES = [
  { key: 'today', days: 1 },
  { key: 'week', days: 7 },
  { key: 'month', days: 30 },
] as const;
type Range = (typeof RANGES)[number]['key'];

const TH = 'px-3 py-2 text-left text-xs font-semibold text-muted-foreground';
const TD = 'tabular px-3 py-2';

/** Clinic admin: the clinic's figures for today, the last 7 or the last 30 days (PRD §9.2). */
export function ClinicFigures() {
  const { api, locale, signOut, t } = useSession();
  const [range, setRange] = useState<Range>('week');
  const [report, setReport] = useState<DashboardReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    const to = istDateKey(new Date());
    const days = RANGES.find((r) => r.key === range)!.days;
    setError(null);
    setReport(null);
    api
      .request('GET', '/dashboard', {
        schema: DashboardReport,
        query: { from: addDays(to, 1 - days), to },
      })
      .then((r) => current && setReport(r))
      .catch((e: unknown) => {
        if (!current) return;
        if (e instanceof ApiError && e.status === 401) return void signOut('expired');
        setError(e instanceof ApiError ? e.message : t('error.network'));
      });
    return () => {
      current = false;
    };
  }, [api, range, signOut, t]);

  const number = (n: number) => n.toLocaleString(locale === 'hi' ? 'hi-IN' : 'en-IN');
  const day = (date: string) =>
    new Intl.DateTimeFormat(locale === 'hi' ? 'hi-IN' : 'en-IN', {
      day: 'numeric',
      month: 'short',
      weekday: 'short',
      timeZone: 'UTC',
    }).format(new Date(`${date}T00:00:00Z`));

  return (
    <section aria-labelledby="figures-title" className="space-y-4" data-testid="clinic-figures">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="figures-title" className="font-display text-xl font-bold">
          {t('figures.title')}
        </h2>
        <div role="group" aria-label={t('figures.range')} className="flex flex-wrap gap-2">
          {RANGES.map((r) => (
            <Button
              key={r.key}
              type="button"
              size="sm"
              variant={range === r.key ? 'default' : 'outline'}
              aria-pressed={range === r.key}
              onClick={() => setRange(r.key)}
            >
              {t(`figures.range.${r.key}`)}
            </Button>
          ))}
        </div>
      </div>

      {error && (
        <p
          role="alert"
          className="rounded-xl bg-danger-soft px-4 py-3 text-sm font-medium text-destructive"
        >
          {error}
        </p>
      )}
      {!report ? (
        !error && (
          <p aria-live="polite" className="text-sm text-muted-foreground">
            {t('common.loading')}
          </p>
        )
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-7">
            <Stat
              label={t('figures.appointments')}
              value={number(report.appointments)}
              icon={<CalendarDays className="size-5" />}
            />
            <Stat
              label={t('figures.completed')}
              value={number(report.completed)}
              icon={<CalendarCheck className="size-5" />}
              tone="ok"
            />
            <Stat
              label={t('figures.cancelled')}
              value={number(report.cancelled)}
              icon={<CalendarX className="size-5" />}
              tone="warn"
            />
            <Stat
              label={
                report.noShowRate === null
                  ? t('figures.noShows')
                  : t('figures.noShowsRate', {
                      rate: Math.round(report.noShowRate * 100).toString(),
                    })
              }
              value={number(report.noShows)}
              icon={<UserX className="size-5" />}
              tone="danger"
            />
            <Stat
              label={t('figures.newPatients')}
              value={number(report.newPatients)}
              icon={<UserPlus className="size-5" />}
              tone="default"
            />
            <Stat
              label={t('figures.prescriptions')}
              value={number(report.prescriptions)}
              icon={<FileSignature className="size-5" />}
              tone="default"
            />
            <Stat
              label={t('figures.collected')}
              value={formatInr(report.collectionsPaise, locale)}
              icon={<IndianRupee className="size-5" />}
              tone="ok"
            />
          </div>

          {report.byDay.length > 1 && (
            <div className="surface overflow-x-auto p-2 sm:p-4">
              <table className="w-full min-w-[34rem] text-sm" data-testid="figures-by-day">
                <caption className="sr-only">{t('figures.byDay')}</caption>
                <thead>
                  <tr className="border-b border-border">
                    <th scope="col" className={TH}>
                      {t('figures.day')}
                    </th>
                    <th scope="col" className={`${TH} text-right`}>
                      {t('figures.appointments')}
                    </th>
                    <th scope="col" className={`${TH} text-right`}>
                      {t('figures.completed')}
                    </th>
                    <th scope="col" className={`${TH} text-right`}>
                      {t('figures.cancelled')}
                    </th>
                    <th scope="col" className={`${TH} text-right`}>
                      {t('figures.noShows')}
                    </th>
                    <th scope="col" className={`${TH} text-right`}>
                      {t('figures.collected')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {[...report.byDay].reverse().map((d) => (
                    <tr key={d.date} className="border-b border-border/60 last:border-0">
                      <th scope="row" className="px-3 py-2 text-left font-medium">
                        {day(d.date)}
                      </th>
                      <td className={`${TD} text-right`}>{number(d.appointments)}</td>
                      <td className={`${TD} text-right`}>{number(d.completed)}</td>
                      <td className={`${TD} text-right`}>{number(d.cancelled)}</td>
                      <td className={`${TD} text-right`}>{number(d.noShows)}</td>
                      <td className={`${TD} text-right`}>
                        {formatInr(d.collectionsPaise, locale)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
