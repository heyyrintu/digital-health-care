'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { InboxTemplates, InboxTemplate } from '@dhc/contracts';
import { Button } from '@dhc/ui-web';
import { useSession } from '../session-provider';
import { ClinicShell, NotAllowed } from '../shell';
export default function Page() {
  return (
    <ClinicShell>
      {(me) => (me.role === 'clinic_admin' ? <Templates /> : <NotAllowed />)}
    </ClinicShell>
  );
}
function Templates() {
  const { api, t } = useSession(),
    [rows, setRows] = useState<ReturnType<typeof InboxTemplates.parse>['data']>([]),
    [available, setAvailable] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const load = useCallback(async () => {
    const r = await api.request('GET', '/inbox/templates', { schema: InboxTemplates });
    setRows(r.data);
    setAvailable(r.available);
  }, [api]);
  useEffect(() => {
    void load().catch((e) => setError(e instanceof Error ? e.message : t('inbox.failed')));
  }, [load, t]);
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('inbox.failed'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-5">
      <Link className="underline" href="/clinic/inbox">
        {t('inbox.title')}
      </Link>
      <h1 className="font-display text-2xl font-bold">{t('inbox.templates')}</h1>
      <p>{t('inbox.templateHelp')}</p>
      {!available && <p role="status">{t('inbox.unavailable')}</p>}
      {error && <p role="alert">{error}</p>}
      <div className="flex flex-wrap gap-3">
        <Button
          disabled={busy || !available}
          onClick={() =>
            void run(async () => {
              const r = await api.request('POST', '/inbox/templates/sync', {
                schema: InboxTemplates,
              });
              setRows(r.data);
            })
          }
        >
          {t('inbox.sync')}
        </Button>
        <Button variant="outline" disabled={busy} onClick={() => void run(load)}>
          {t('inbox.refresh')}
        </Button>
        <a
          href="https://business.facebook.com/wa/manage/message-templates/"
          target="_blank"
          rel="noreferrer"
          className="self-center underline"
        >
          {t('inbox.metaManager')}
        </a>
      </div>
      {!rows.length && <p>{t('inbox.noTemplates')}</p>}
      {rows.map((r) => (
        <article className="surface space-y-3 p-4" key={r.id}>
          <h2 className="font-semibold">
            {r.name} · {r.language}
          </h2>
          <p>
            {r.category} · {r.providerStatus}
          </p>
          <p className="whitespace-pre-wrap break-words">{r.body}</p>
          <p>{t('inbox.lastSync', { date: new Date(r.verifiedAt).toLocaleString() })}</p>
          {!r.supported && <p>{t('inbox.templateUnsupported')}</p>}
          <Button
            variant={r.enabled ? 'outline' : 'default'}
            disabled={
              busy ||
              !available ||
              (!r.enabled && (!r.supported || r.providerStatus !== 'APPROVED'))
            }
            onClick={() =>
              void run(async () => {
                await api.request('POST', `/inbox/templates/${r.id}`, {
                  schema: InboxTemplate,
                  body: { revision: r.revision, enabled: !r.enabled },
                });
                await load();
              })
            }
          >
            {t(r.enabled ? 'inbox.disable' : 'inbox.enable')}
          </Button>
        </article>
      ))}
    </div>
  );
}
