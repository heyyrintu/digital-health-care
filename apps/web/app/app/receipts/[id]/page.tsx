'use client';
import { PortalReceipt } from '@dhc/contracts';
import { formatInr, formatIstDateTime } from '@dhc/domain';
import { Button } from '@dhc/ui-web';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { ReceiptDocument } from '../../../../components/receipt-document';
import { PortalShell } from '../../shell';
import { usePatientSession } from '../../session-provider';
import { LoadError, Loading, PortalPage } from '../../parts';
export default function Page() {
  const { id } = useParams<{ id: string }>();
  return <PortalShell>{() => <ReceiptScreen key={id} id={id} />}</PortalShell>;
}
function ReceiptScreen({ id }: { id: string }) {
  const { api, t, locale } = usePatientSession(),
    [receipt, setReceipt] = useState<PortalReceipt | null>(null),
    [error, setError] = useState<unknown>();
  const load = useCallback(async () => {
    setError(undefined);
    try {
      setReceipt(await api.request('GET', `/portal/receipts/${id}`, { schema: PortalReceipt }));
    } catch (e) {
      setError(e);
    }
  }, [api, id]);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <PortalPage title={t('finance.openReceipt')}>
      <style>{'@page { size: A5; margin: 12mm; }'}</style>
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Link className="underline" href="/app/payments">
          {t('finance.title')}
        </Link>
        {receipt && <Button onClick={() => window.print()}>{t('finance.print')}</Button>}
      </div>
      {error ? (
        <LoadError error={error} retry={() => void load()} />
      ) : receipt ? (
        <>
          <ReceiptDocument receipt={receipt} locale={locale} t={t} />
          <p className="text-sm">{t('finance.originalReceipt')}</p>
          {!!receipt.refunds?.length && (
            <section className="space-y-3">
              <h2>{t('finance.refundUpdates')}</h2>
              {receipt.refunds.map((r) => (
                <div key={r.id}>
                  <p>
                    {r.voucherNumber} · {formatInr(r.amountPaise, locale)} ·{' '}
                    {formatIstDateTime(r.postedAt, locale)}
                  </p>
                </div>
              ))}
            </section>
          )}
        </>
      ) : (
        <Loading />
      )}
    </PortalPage>
  );
}
