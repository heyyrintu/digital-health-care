'use client';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { LoadError, Loading, PortalPage } from '../../../parts';
import Link from 'next/link';
import { FinanceLinkTarget } from '@dhc/contracts';
import { usePatientSession } from '../../../session-provider';
import { PortalShell } from '../../../shell';

export default function RecordPage() {
  const { token } = useParams<{ token: string }>();
  const clinic = useSearchParams().get('clinic');
  const { status, me } = usePatientSession();
  const router = useRouter();
  const ready = status === 'signedIn' && (!clinic || me?.organisation.slug === clinic);
  useEffect(() => {
    if (status !== 'signedOut' && !(status === 'signedIn' && !ready)) return;
    const next = `/app/payments/notice/${encodeURIComponent(token)}${clinic ? `?clinic=${encodeURIComponent(clinic)}` : ''}`;
    const params = new URLSearchParams({ next });
    if (clinic) params.set('clinic', clinic);
    router.replace(`/app/login?${params}`);
  }, [status, ready, router, token, clinic]);
  if (!ready) return <Loading />;
  return <PortalShell>{() => <Record token={token} />}</PortalShell>;
}
function Record({ token }: { token: string }) {
  const { api, t } = usePatientSession();
  const [target, setTarget] = useState<FinanceLinkTarget | null>(null);
  const [error, setError] = useState<unknown>();
  const [run, setRun] = useState(0);
  useEffect(() => {
    let live = true;
    setTarget(null);
    setError(undefined);
    api
      .request('GET', `/portal/finance-links/${token}`, { schema: FinanceLinkTarget })
      .then((v) => {
        if (live) setTarget(v);
      })
      .catch((e: unknown) => {
        if (live) setError(e);
      });
    return () => {
      live = false;
    };
  }, [api, token, run]);
  return (
    <PortalPage title={t('finance.notice')}>
      <Link className="block underline" href="/app/payments">
        {t('finance.title')}
      </Link>
      {error ? (
        <LoadError error={error} retry={() => setRun((n) => n + 1)} />
      ) : target ? (
        <>
          {target.kind === 'payment_link' && target.paymentUrl ? (
            <a className="underline" href={target.paymentUrl} referrerPolicy="no-referrer">
              {t('prepaid.pay')}
            </a>
          ) : (
            <Link className="underline" href={`/app/receipts/${target.sourceId}`}>
              {t('finance.openReceipt')}
            </Link>
          )}
        </>
      ) : (
        <Loading />
      )}
    </PortalPage>
  );
}
