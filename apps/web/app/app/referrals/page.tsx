'use client';
import type { ApiClient } from '@dhc/api-client';
import { Button, EmptyState, Surface } from '@dhc/ui-web';
import { useCallback, useEffect, useState } from 'react';
import { LoadError, Loading, PortalPage } from '../parts';
import { RecordOpener } from '../record-opener';
import { usePatientSession } from '../session-provider';
import { PortalShell } from '../shell';
export default function ReferralsPage() {
  return <PortalShell>{() => <Letters />}</PortalShell>;
}
function Letters() {
  const { api, t, locale } = usePatientSession();
  const [page, setPage] = useState<Awaited<ReturnType<ApiClient['portalReferralLetters']>> | null>(
    null,
  );
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const load = useCallback(
    async (cursor?: string) => {
      setBusy(true);
      setError(undefined);
      try {
        const result = await api.portalReferralLetters(cursor);
        setPage((old) =>
          cursor && old
            ? {
                ...result,
                data: [
                  ...old.data,
                  ...result.data.filter((r) => !old.data.some((v) => v.id === r.id)),
                ],
              }
            : result,
        );
      } catch (e) {
        setError(e);
      } finally {
        setBusy(false);
      }
    },
    [api],
  );
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <PortalPage title={t('patient.nav.referrals')}>
      {error ? (
        <LoadError error={error} retry={() => void load(page?.nextCursor ?? undefined)} />
      ) : null}
      {!page && !error && <Loading />}
      {page && !page.data.length && <EmptyState title={t('portal.referrals.none')} />}
      {page?.data.map((row) => (
        <Surface key={row.id} className="space-y-3 p-4">
          <p>{row.patientName}</p>
          <p>
            {new Intl.DateTimeFormat(locale, {
              timeZone: 'Asia/Kolkata',
              dateStyle: 'medium',
            }).format(new Date(row.signedAt))}
          </p>
          <RecordOpener
            target={{ kind: 'referral_ready', sourceId: row.id, mediaType: 'application/pdf' }}
          />
        </Surface>
      ))}
      {page?.nextCursor && (
        <Button disabled={busy} onClick={() => void load(page.nextCursor!)}>
          {t('referrals.loadMore')}
        </Button>
      )}
    </PortalPage>
  );
}
