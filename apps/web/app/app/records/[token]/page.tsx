'use client';
import type { RecordLinkTarget } from '@dhc/contracts';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { LoadError, Loading, PortalPage } from '../../parts';
import { RecordOpener } from '../../record-opener';
import { usePatientSession } from '../../session-provider';
import { PortalShell } from '../../shell';

export default function RecordPage() {
  const { token } = useParams<{ token: string }>();
  const clinic = useSearchParams().get('clinic');
  const { status, me } = usePatientSession();
  const router = useRouter();
  const ready = status === 'signedIn' && (!clinic || me?.organisation.slug === clinic);
  useEffect(() => {
    if (status !== 'signedOut' && !(status === 'signedIn' && !ready)) return;
    const next = `/app/records/${encodeURIComponent(token)}${clinic ? `?clinic=${encodeURIComponent(clinic)}` : ''}`;
    const params = new URLSearchParams({ next });
    if (clinic) params.set('clinic', clinic);
    router.replace(`/app/login?${params}`);
  }, [status, ready, router, token, clinic]);
  if (!ready) return <Loading />;
  return <PortalShell>{() => <Record token={token} />}</PortalShell>;
}
function Record({ token }: { token: string }) {
  const { api, t } = usePatientSession();
  const [target, setTarget] = useState<RecordLinkTarget | null>(null);
  const [error, setError] = useState<unknown>();
  const [run, setRun] = useState(0);
  useEffect(() => {
    let live = true;
    setTarget(null);
    setError(undefined);
    api
      .portalRecordLink(token)
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
    <PortalPage title={t('portal.record.title')}>
      {error ? (
        <LoadError error={error} retry={() => setRun((n) => n + 1)} />
      ) : target ? (
        <RecordOpener target={target} />
      ) : (
        <Loading />
      )}
    </PortalPage>
  );
}
