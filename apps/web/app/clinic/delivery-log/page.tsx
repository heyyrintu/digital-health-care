'use client';

import { ApiError } from '@dhc/api-client';
import { WhatsAppDeliveryList, type WhatsAppDeliveryEntry } from '@dhc/contracts';
import { formatIstDateTime } from '@dhc/domain';
import { Button, PageHeader, Surface } from '@dhc/ui-web';
import { useCallback, useEffect, useState } from 'react';
import { useSession } from '../session-provider';
import { ClinicShell, NotAllowed } from '../shell';

export default function DeliveryLogPage() {
  return (
    <ClinicShell>
      {(me) => (me.role === 'clinic_admin' ? <DeliveryLog /> : <NotAllowed />)}
    </ClinicShell>
  );
}

function DeliveryLog() {
  const { api, t, locale, signOut } = useSession();
  const [rows, setRows] = useState<WhatsAppDeliveryEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(
    async (next?: string) => {
      setBusy(true);
      setError(null);
      try {
        const page = await api.request('GET', '/delivery-log', {
          schema: WhatsAppDeliveryList,
          query: { limit: 50, cursor: next },
        });
        setRows((previous) =>
          next
            ? [...new Map([...previous, ...page.data].map((r) => [r.id, r])).values()]
            : page.data,
        );
        setCursor(page.nextCursor);
        setLoaded(true);
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return void signOut('expired');
        setError(e instanceof ApiError ? e.message : t('error.network'));
      } finally {
        setBusy(false);
      }
    },
    [api, signOut, t],
  );
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-6">
      <PageHeader title={t('delivery.title')} sub={t('delivery.description')} />
      <Button variant="outline" disabled={busy} onClick={() => void load()}>
        {t('delivery.refresh')}
      </Button>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <Surface className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr>
              {(
                [
                  'delivery.type',
                  'delivery.created',
                  'delivery.status',
                  'delivery.updated',
                  'delivery.error',
                ] as const
              ).map((key) => (
                <th key={key} className="px-4 py-3">
                  {t(key)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-t border-border">
                <td className="px-4 py-3">{t(`delivery.kind.${row.kind}`)}</td>
                <td className="px-4 py-3">{formatIstDateTime(row.createdAt, locale)}</td>
                <td className="px-4 py-3">{t(`delivery.state.${row.status}`)}</td>
                <td className="px-4 py-3">{formatIstDateTime(row.lastStatusAt, locale)}</td>
                <td className="px-4 py-3">{row.errorCode ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {loaded && !rows.length && (
          <p className="p-4 text-muted-foreground">{t('delivery.empty')}</p>
        )}
        {busy && (
          <p className="p-4" aria-live="polite">
            {t('common.loading')}
          </p>
        )}
      </Surface>
      {cursor && (
        <Button variant="outline" disabled={busy} onClick={() => void load(cursor)}>
          {t('delivery.more')}
        </Button>
      )}
    </div>
  );
}
