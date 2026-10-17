'use client';

import { ApiError } from '@dhc/api-client';
import type { PlatformUsageReport } from '@dhc/contracts';
import { formatInr } from '@dhc/domain';
import { Button, Input, PageHeader, Surface } from '@dhc/ui-web';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  countOrDash,
  defaultUsageRange,
  platformErrorKey,
  usageRangeProblem,
} from '../../../lib/platform';
import { usePlatformSession } from '../session-provider';
import { ErrorNotice, PlatformShell } from '../shell';

const TH = 'py-2 pr-3 text-left text-xs font-semibold text-muted-foreground';
const NUM = 'py-2 pr-3 text-right tabular';

/** Usage per organisation over a range of IST days (PRD §9.3). Counts only. */
export default function UsagePage() {
  return <PlatformShell>{() => <UsageScreen />}</PlatformShell>;
}

function UsageScreen() {
  const { api, locale, signOut, t } = usePlatformSession();
  const [range, setRange] = useState(() => defaultUsageRange(new Date()));
  const [draft, setDraft] = useState(range);
  const [report, setReport] = useState<PlatformUsageReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rangeError, setRangeError] = useState<string | null>(null);

  const load = useCallback(
    async (from: string, to: string) => {
      setError(null);
      setReport(null);
      try {
        setReport(await api.platform.usage({ from, to }));
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return void signOut('expired');
        const key = platformErrorKey(e, 'page');
        setError(key ? t(key) : (e as Error).message);
      }
    },
    [api, signOut, t],
  );

  useEffect(() => {
    void load(range.from, range.to);
  }, [load, range]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const problem = usageRangeProblem(draft.from, draft.to);
    setRangeError(problem ? t(problem) : null);
    if (!problem) setRange({ ...draft });
  }

  const count = (n: number | null) => countOrDash(n, locale);

  return (
    <section className="space-y-5">
      <PageHeader title={t('platform.usage.title')} sub={t('platform.usage.sub')} />

      <Surface className="p-4 sm:p-5">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={submit}
          noValidate
          aria-label={t('platform.usage.title')}
        >
          <div className="space-y-1.5">
            <label className="block text-sm font-medium" htmlFor="usage-from">
              {t('platform.usage.from')}
            </label>
            <Input
              id="usage-from"
              type="date"
              value={draft.from}
              onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value }))}
              aria-invalid={rangeError ? true : undefined}
              aria-describedby={rangeError ? 'usage-range-error' : undefined}
            />
          </div>
          <div className="space-y-1.5">
            <label className="block text-sm font-medium" htmlFor="usage-to">
              {t('platform.usage.to')}
            </label>
            <Input
              id="usage-to"
              type="date"
              value={draft.to}
              onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value }))}
              aria-invalid={rangeError ? true : undefined}
              aria-describedby={rangeError ? 'usage-range-error' : undefined}
            />
          </div>
          <Button type="submit">{t('platform.usage.show')}</Button>
        </form>
        {rangeError && (
          <div className="mt-3">
            <ErrorNotice id="usage-range-error" message={rangeError} />
          </div>
        )}
      </Surface>

      <ErrorNotice message={error} />

      <Surface className="min-w-0 p-4 sm:p-6">
        {!report ? (
          !error && (
            <p aria-live="polite" className="text-sm text-muted-foreground">
              {t('common.loading')}
            </p>
          )
        ) : (
          <>
            <p className="mb-3 text-sm text-muted-foreground" data-testid="usage-range">
              {t('platform.usage.range', { from: report.from, to: report.to })}
            </p>
            {report.data.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('platform.usage.empty')}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[48rem] text-sm" data-testid="usage">
                  <thead>
                    <tr className="border-b border-border">
                      <th scope="col" className={TH}>
                        {t('platform.usage.organisation')}
                      </th>
                      <th scope="col" className={`${TH} text-right`}>
                        {t('platform.usage.appointments')}
                      </th>
                      <th scope="col" className={`${TH} text-right`}>
                        {t('platform.usage.prescriptions')}
                      </th>
                      <th scope="col" className={`${TH} text-right`}>
                        {t('platform.usage.payments')}
                      </th>
                      <th scope="col" className={`${TH} text-right`}>
                        {t('platform.usage.amount')}
                      </th>
                      <th scope="col" className={`${TH} text-right`}>
                        {t('platform.usage.messages')}
                      </th>
                      <th scope="col" className={`${TH} text-right`}>
                        {t('platform.usage.scribeMinutes')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.data.map((row) => (
                      <tr
                        key={row.organisation.id}
                        data-testid={`usage-${row.organisation.slug}`}
                        className="border-b border-border/60"
                      >
                        <th scope="row" className="py-2 pr-3 text-left font-normal">
                          <strong className="font-semibold">{row.organisation.name}</strong>
                          <span className="block text-xs text-muted-foreground">
                            {row.organisation.slug}
                            {row.organisation.status === 'suspended' &&
                              ` · ${t('platform.orgs.status.suspended')}`}
                          </span>
                        </th>
                        <td className={NUM}>{count(row.appointments)}</td>
                        <td className={NUM}>{count(row.prescriptions)}</td>
                        <td className={NUM}>{count(row.payments.count)}</td>
                        <td className={NUM}>{formatInr(row.payments.amountPaise, locale)}</td>
                        <td className={NUM} data-testid="usage-messages">
                          {count(row.messages)}
                        </td>
                        <td className={NUM} data-testid="usage-scribe">
                          {count(row.scribeMinutes)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="mt-3 text-xs text-muted-foreground" data-testid="usage-not-built">
              {t('platform.usage.notBuilt')}
            </p>
          </>
        )}
      </Surface>
    </section>
  );
}
