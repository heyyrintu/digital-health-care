'use client';

import { ApiError } from '@dhc/api-client';
import { Receipt } from '@dhc/contracts';
import { ReceiptDocument } from '../../../../components/receipt-document';
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

          <ReceiptDocument receipt={receipt} locale={locale} t={t} />
        </>
      )}
    </section>
  );
}
