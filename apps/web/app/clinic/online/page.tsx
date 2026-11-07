'use client';
import { AppointmentList, OnlineSettings } from '@dhc/contracts';
import { Button, Field, Input, Surface } from '@dhc/ui-web';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ClinicShell } from '../shell';
import { useSession } from '../session-provider';
export default function Page() {
  return <ClinicShell>{(me) => <Online admin={me.role === 'clinic_admin'} />}</ClinicShell>;
}
function Online({ admin }: { admin: boolean }) {
  const { api, t } = useSession();
  const [settings, setSettings] = useState<OnlineSettings | null>(null),
    [enabled, setEnabled] = useState(false),
    [date, setDate] = useState(new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10)),
    [rows, setRows] = useState<AppointmentList['data']>([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    if (admin)
      api
        .request('GET', '/online-settings', { schema: OnlineSettings })
        .then((value) => {
          setSettings(value);
          setEnabled(value.enabled);
        })
        .catch(() => setError(t('online.error')));
  }, [api, admin, t]);
  async function work(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('online.error'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <h1 className="text-2xl font-bold">{t('online.title')}</h1>
      <p>{t('online.external')}</p>
      {error && <p role="alert">{error}</p>}
      {admin && settings && (
        <Surface className="space-y-3 p-5">
          <p>{t('online.settingsInfo')}</p>
          <label className="flex min-h-11 items-start gap-3">
            <input
              type="checkbox"
              checked={enabled}
              disabled={busy}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            {t('online.enable')}
          </label>
          <Button
            disabled={busy}
            onClick={() =>
              void work(async () =>
                setSettings(
                  await api.request('PUT', '/online-settings', {
                    schema: OnlineSettings,
                    body: { version: settings.version, enabled },
                  }),
                ),
              )
            }
          >
            {t('online.saveSettings')}
          </Button>
        </Surface>
      )}
      <Surface className="space-y-4 p-5">
        <Field label={t('online.date')}>
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Button
          disabled={busy}
          onClick={() =>
            void work(async () => {
              const r = await api.request('GET', '/appointments?date=' + date, {
                schema: AppointmentList,
              });
              setRows(r.data.filter((a) => a.mode !== 'in_person'));
            })
          }
        >
          {t('online.load')}
        </Button>
        {rows.map((a) => (
          <p key={a.id}>
            <Link className="underline" href={'/clinic/online/' + a.id}>
              {a.patient.name} · {a.mode} ·{' '}
              {new Date(a.startAt).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })}
            </Link>
          </p>
        ))}
      </Surface>
    </div>
  );
}
