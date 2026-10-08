'use client';

import { ApiError } from '@dhc/api-client';
import { Receipt } from '@dhc/contracts';
import { formatInr, formatIstDateTime } from '@dhc/domain';
import { Button } from '@dhc/ui-web';
import { ArrowLeft, Printer } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useSession } from '../../session-provider';
import { ClinicShell, NotAllowed } from '../../shell';

/** A payment's receipt (PRD §5.6), laid out for A5 printing; the staff frame hides in print. */
export default function ReceiptPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <ClinicShell>
      {(me) => (me.role === 'patient' ? <NotAllowed /> : <ReceiptScreen key={id} id={id} />)}
    </ClinicShell>
  );
}

function ReceiptScreen({ id }: { id: string }) {
  const { api, locale, signOut, t } = useSession();
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setError(null);
    api
      .request('GET', `/payments/${encodeURIComponent(id)}/receipt`, { schema: Receipt })
      .then((r) => current && setReceipt(r))
      .catch((e: unknown) => {
        if (!current) return;
        if (e instanceof ApiError && e.status === 401) return void signOut('expired');
        setError(e instanceof ApiError ? e.message : t('error.network'));
      });
    return () => {
      current = false;
    };
  }, [api, id, signOut, t]);

  const money = (paise: number) => formatInr(paise, locale);

  return (
    <section className="mx-auto max-w-xl space-y-5">
      <style>{'@page { size: A5; margin: 12mm; }'}</style>
      {error && (
        <p
          role="alert"
          className="rounded-xl bg-danger-soft px-4 py-3 text-sm font-medium text-destructive"
        >
          {error}
        </p>
      )}
      {!receipt ? (
        !error && (
          <p aria-live="polite" className="text-sm text-muted-foreground">
            {t('common.loading')}
          </p>
        )
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 print:hidden">
            <Link
              href={`/clinic/appointments/${receipt.appointmentId}/bill`}
              className="inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              <ArrowLeft className="size-4" aria-hidden />
              {t('receipt.back')}
            </Link>
            <Button type="button" onClick={() => window.print()}>
              <Printer aria-hidden />
              {t('receipt.print')}
            </Button>
          </div>

          <article
            className="surface space-y-5 p-6 print:rounded-none print:border-0 print:p-0 print:shadow-none"
            data-testid="receipt"
          >
            <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-4">
              <div>
                <p className="font-display text-lg font-bold">{receipt.organisationName}</p>
                <h1 className="font-display text-2xl font-extrabold">
                  {t('receipt.title', { number: receipt.payment.receiptNumber })}
                </h1>
              </div>
              <p className="tabular text-right text-sm text-muted-foreground">
                {t('receipt.received')}
                <br />
                {formatIstDateTime(receipt.payment.receivedAt, locale)}
              </p>
            </header>

            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
              <dt className="text-muted-foreground">{t('receipt.patient')}</dt>
              <dd>
                {receipt.patient.name} · <span className="tabular">{receipt.patient.uhid}</span>
              </dd>
              <dt className="text-muted-foreground">{t('receipt.doctor')}</dt>
              <dd>{receipt.doctorName ?? '—'}</dd>
              <dt className="text-muted-foreground">{t('receipt.visit')}</dt>
              <dd className="tabular">{receipt.visitDate}</dd>
            </dl>

            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th scope="col" className="py-2 font-semibold">
                    {t('receipt.line')}
                  </th>
                  <th scope="col" className="py-2 text-right font-semibold">
                    {t('receipt.qty')}
                  </th>
                  <th scope="col" className="py-2 text-right font-semibold">
                    {t('receipt.rate')}
                  </th>
                  <th scope="col" className="py-2 text-right font-semibold">
                    {t('receipt.amount')}
                  </th>
                </tr>
              </thead>
              <tbody className="tabular">
                {receipt.lines.map((line) => (
                  <tr key={line.id} className="border-b border-border/60">
                    <td className="py-2">{line.name}</td>
                    <td className="py-2 text-right">{line.quantity}</td>
                    <td className="py-2 text-right">{money(line.unitPaise)}</td>
                    <td className="py-2 text-right">{money(line.amountPaise)}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <dl className="tabular ml-auto max-w-xs space-y-1.5 text-sm">
              <Row label={t('billing.subtotal')} value={money(receipt.subtotalPaise)} />
              {receipt.discountPaise > 0 && (
                <Row
                  label={t('billing.discountLine')}
                  value={`− ${money(receipt.discountPaise)}`}
                />
              )}
              <Row label={t('billing.total')} value={money(receipt.totalPaise)} strong />
              <Row
                label={t('receipt.thisPayment', {
                  mode: t(`billing.mode.${receipt.payment.mode}`),
                })}
                value={money(receipt.payment.amountPaise)}
                strong
              />
              <Row label={t('receipt.paidToDate')} value={money(receipt.paidToDatePaise)} />
              <Row label={t('receipt.balanceAfter')} value={money(receipt.balanceAfterPaise)} />
            </dl>

            <footer className="space-y-1 border-t border-border pt-4 text-xs text-muted-foreground">
              {receipt.payment.reference && (
                <p>{t('receipt.reference', { reference: receipt.payment.reference })}</p>
              )}
              {receipt.payment.receivedByName && (
                <p>{t('receipt.by', { name: receipt.payment.receivedByName })}</p>
              )}
            </footer>
          </article>
        </>
      )}
    </section>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={strong ? 'flex justify-between gap-4 font-bold' : 'flex justify-between gap-4'}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
