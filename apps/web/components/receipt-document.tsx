'use client';
import type { Receipt } from '@dhc/contracts';
import { formatInr, formatIstDateTime } from '@dhc/domain';
import type { Locale, MessageKey } from '@dhc/i18n';
export function ReceiptDocument({
  receipt,
  locale,
  t,
}: {
  receipt: Receipt;
  locale: Locale;
  t: (key: MessageKey, params?: Record<string, string | number>) => string;
}) {
  const money = (n: number) => formatInr(n, locale);
  return (
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
          <Row label={t('billing.discountLine')} value={`− ${money(receipt.discountPaise)}`} />
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
