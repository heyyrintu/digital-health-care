'use client';
import { ApiError } from '@dhc/api-client';
import type { RefundVoucher } from '@dhc/contracts';
import { formatInr, formatIstDateTime } from '@dhc/domain';
import { Button, Surface } from '@dhc/ui-web';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { useSession } from '../../session-provider';
import { ClinicShell, NotAllowed } from '../../shell';
export default function Page() {
  const { id } = useParams<{ id: string }>();
  return (
    <ClinicShell>
      {(me) => (me.role === 'patient' ? <NotAllowed /> : <Voucher id={id} />)}
    </ClinicShell>
  );
}
function Voucher({ id }: { id: string }) {
  const { api, t, locale, signOut } = useSession(),
    [value, setValue] = useState<RefundVoucher | null>(null),
    [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setError(null);
    try {
      setValue(await api.refundVoucher(id));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        void signOut('expired');
        return;
      }
      setError(e instanceof ApiError ? e.message : t('error.network'));
    }
  }, [api, id, signOut, t]);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <section className="mx-auto max-w-xl space-y-5">
      <style>{'@page { size: A5; margin: 12mm; }'}</style>
      <h1 className="font-display text-2xl font-bold">{t('refund.voucher')}</h1>
      {error && <p role="alert">{error}</p>}
      {!value && (
        <Button className="print:hidden" onClick={() => void load()}>
          {t(error ? 'common.retry' : 'common.loading')}
        </Button>
      )}
      {value && (
        <>
          <div className="flex flex-wrap gap-3 print:hidden">
            <Link
              className="text-primary underline"
              href={`/clinic/appointments/${value.originalReceipt.appointmentId}/bill`}
            >
              {t('receipt.back')}
            </Link>
            <Button onClick={() => window.print()}>{t('refund.print')}</Button>
          </div>
          <Surface className="space-y-4 p-5 print:shadow-none">
            <h2 className="font-display text-xl font-bold">
              {value.originalReceipt.organisationName}
            </h2>
            <p className="font-bold">{value.refund.voucherNumber}</p>
            <p>
              {value.originalReceipt.patient.name} · {value.originalReceipt.patient.uhid}
            </p>
            <p>
              {t('refund.original')}: {value.originalReceipt.payment.receiptNumber}
            </p>
            <p>
              {t('refund.state.succeeded')}: {formatInr(value.refund.amountPaise, locale)}
            </p>
            {value.refund.postedAt && <p>{formatIstDateTime(value.refund.postedAt, locale)}</p>}
            <p>
              {t('refund.source')}: {value.refund.providerReference}
            </p>
            <p className="text-sm">{t('refund.note')}</p>
          </Surface>
        </>
      )}
    </section>
  );
}
