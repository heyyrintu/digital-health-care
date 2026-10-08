'use client';

import { ApiError } from '@dhc/api-client';
import { CollectionsReport } from '@dhc/contracts';
import { formatInr, istDateKey } from '@dhc/domain';
import { buttonVariants, Input, Label, PageHeader, Surface } from '@dhc/ui-web';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useSession } from '../session-provider';
import { ClinicShell, NotAllowed } from '../shell';

const H2 = 'font-display text-lg font-bold';
const TH = 'py-2 text-left text-xs font-semibold text-muted-foreground';

/** One day's counter collections by mode and doctor, and what is still due (PRD §5.6). */
export default function CollectionsPage() {
  return (
    <ClinicShell>
      {(me) => (me.role === 'patient' ? <NotAllowed /> : <CollectionsScreen />)}
    </ClinicShell>
  );
}

function CollectionsScreen() {
  const { api, locale, signOut, t } = useSession();
  const [date, setDate] = useState(() => istDateKey(new Date()));
  const [report, setReport] = useState<CollectionsReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setError(null);
    setReport(null);
    api
      .request('GET', '/collections', { schema: CollectionsReport, query: { date } })
      .then((r) => current && setReport(r))
      .catch((e: unknown) => {
        if (!current) return;
        if (e instanceof ApiError && e.status === 401) return void signOut('expired');
        setError(e instanceof ApiError ? e.message : t('error.network'));
      });
    return () => {
      current = false;
    };
  }, [api, date, signOut, t]);

  const money = (paise: number) => formatInr(paise, locale);
  const payments = (count: number) =>
    count === 1 ? t('collections.countOne') : t('collections.count', { count });
  const time = (iso: string) =>
    new Intl.DateTimeFormat(locale === 'hi' ? 'hi-IN' : 'en-IN', {
      timeZone: 'Asia/Kolkata',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(iso));

  return (
    <section className="space-y-5">
      <PageHeader
        title={t('collections.title')}
        actions={
          <div className="space-y-1.5">
            <Label htmlFor="collections-date" className="text-sm font-semibold">
              {t('collections.date')}
            </Label>
            <Input
              id="collections-date"
              type="date"
              value={date}
              onChange={(e) => e.target.value && setDate(e.target.value)}
            />
          </div>
        }
      />
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
          <div
            className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"
            data-testid="collections-totals"
          >
            <Surface className="p-5">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t('collections.total')}
              </p>
              <p className="tabular mt-1 font-display text-3xl font-extrabold">
                {money(report.totalPaise)}
              </p>
              <p className="text-xs text-muted-foreground">{payments(report.payments.length)}</p>
            </Surface>
            {report.byMode.map((m) => (
              <Surface key={m.mode} className="p-5" data-testid={`mode-${m.mode}`}>
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {t(`billing.mode.${m.mode}`)}
                </p>
                <p className="tabular mt-1 font-display text-2xl font-bold">
                  {money(m.amountPaise)}
                </p>
                <p className="text-xs text-muted-foreground">{payments(m.count)}</p>
              </Surface>
            ))}
          </div>

          <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <Surface className="min-w-0 p-5 sm:p-6">
              <h2 className={H2}>{t('collections.payments')}</h2>
              {report.payments.length === 0 ? (
                <p className="mt-3 text-sm text-muted-foreground">{t('collections.noPayments')}</p>
              ) : (
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full min-w-[34rem] text-sm" data-testid="collection-payments">
                    <thead>
                      <tr className="border-b border-border">
                        <th scope="col" className={TH}>
                          {t('collections.time')}
                        </th>
                        <th scope="col" className={TH}>
                          {t('collections.patient')}
                        </th>
                        <th scope="col" className={TH}>
                          {t('billing.mode')}
                        </th>
                        <th scope="col" className={TH}>
                          {t('collections.receiptNo')}
                        </th>
                        <th scope="col" className={`${TH} text-right`}>
                          {t('receipt.amount')}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.payments.map((p) => (
                        <tr key={p.id} className="border-b border-border/60">
                          <td className="tabular py-2">{time(p.receivedAt)}</td>
                          <td className="py-2">
                            {p.patientName}{' '}
                            <span className="tabular text-muted-foreground">{p.uhid}</span>
                          </td>
                          <td className="py-2">{t(`billing.mode.${p.mode}`)}</td>
                          <td className="py-2">
                            <Link
                              href={`/clinic/receipts/${p.id}`}
                              className="tabular font-medium text-primary underline-offset-4 hover:underline"
                            >
                              {p.receiptNumber}
                            </Link>
                          </td>
                          <td className="tabular py-2 text-right">{money(p.amountPaise)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Surface>

            <div className="space-y-5">
              <Surface className="p-5 sm:p-6">
                <h2 className={H2}>{t('collections.byDoctor')}</h2>
                {report.byDoctor.length === 0 ? (
                  <p className="mt-3 text-sm text-muted-foreground">
                    {t('collections.noPayments')}
                  </p>
                ) : (
                  <ul className="mt-3 divide-y divide-border/70">
                    {report.byDoctor.map((d) => (
                      <li
                        key={d.doctorUserId}
                        className="flex justify-between gap-3 py-2.5 text-sm"
                      >
                        <span>
                          {d.doctorName ?? t('availability.doctor')}
                          <span className="text-muted-foreground"> · {payments(d.count)}</span>
                        </span>
                        <span className="tabular font-semibold">{money(d.amountPaise)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Surface>

              <Surface className="p-5 sm:p-6" data-testid="collection-dues">
                <h2 className={H2}>{t('collections.dues')}</h2>
                {report.dues.length === 0 ? (
                  <p className="mt-3 text-sm text-muted-foreground">{t('collections.noDues')}</p>
                ) : (
                  <ul className="mt-3 divide-y divide-border/70">
                    {report.dues.map((d) => (
                      <li
                        key={d.billId}
                        className="flex flex-wrap items-center gap-3 py-2.5 text-sm"
                      >
                        <span className="min-w-0 flex-1">
                          {d.patientName}{' '}
                          <span className="tabular text-muted-foreground">{d.uhid}</span>
                        </span>
                        <span className="tabular font-semibold text-warning-foreground">
                          {money(d.balancePaise)}
                        </span>
                        <Link
                          href={`/clinic/appointments/${d.appointmentId}/bill`}
                          className={buttonVariants({ variant: 'outline', size: 'sm' })}
                          aria-label={t('collections.openBill', { name: d.patientName })}
                        >
                          {t('action.bill')}
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </Surface>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
