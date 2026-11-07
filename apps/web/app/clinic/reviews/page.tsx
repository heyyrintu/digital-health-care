'use client';
import { ApiError } from '@dhc/api-client';
import { AppointmentList, ReviewSettings, ReviewRequestList, ReviewRequest } from '@dhc/contracts';
import { Button, Field, Input, NativeSelect, Surface } from '@dhc/ui-web';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ClinicShell } from '../shell';
import { useSession } from '../session-provider';
export default function Page() {
  return <ClinicShell>{(me) => <Reviews admin={me.role === 'clinic_admin'} />}</ClinicShell>;
}
function Reviews({ admin }: { admin: boolean }) {
  const { api, t, locale } = useSession();
  const [settings, setSettings] = useState<ReviewSettings | null>(null),
    [rows, setRows] = useState<ReviewRequest[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [metrics, setMetrics] = useState({ total: 0, accepted: 0, sent: 0, delivered: 0, opened: 0 }),
    [visits, setVisits] = useState<AppointmentList['data']>([]),
    [date, setDate] = useState(new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10)),
    [chosen, setChosen] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [recovering, setRecovering] = useState(false);
  const attempt = useRef<{ id: string; appointmentId: string } | null>(null);
  const fail = useCallback(
    (e: unknown) => setError(e instanceof ApiError ? e.message : t('reviews.error')),
    [t],
  );
  const load = useCallback(
    async (next?: string) => {
      const r = await api.request('GET', '/review-requests' + (next ? '?cursor=' + next : ''), {
        schema: ReviewRequestList,
      });
      setRows((old) => (next ? [...old, ...r.data] : r.data));
      setCursor(r.nextCursor);
      setMetrics(r.metrics);
    },
    [api],
  );
  useEffect(() => {
    void load().catch(fail);
    if (admin)
      void api
        .request('GET', '/review-settings', { schema: ReviewSettings })
        .then(setSettings)
        .catch(fail);
  }, [api, admin, load, fail]);
  const work = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await fn();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  async function request() {
    const body = attempt.current ?? { id: crypto.randomUUID(), appointmentId: chosen };
    attempt.current = body;
    setRecovering(true);
    await work(async () => {
      try {
        await api.request('POST', '/review-requests', { schema: ReviewRequest, body });
      } catch (e) {
        if (e instanceof ApiError && [400, 403, 404, 409, 422].includes(e.status)) {
          attempt.current = null;
          setRecovering(false);
        }
        throw e;
      }
      attempt.current = null;
      setRecovering(false);
      setNotice(t('reviews.queued'));
      await load();
    });
  }
  return (
    <section className="space-y-6">
      <h1 className="text-2xl font-bold">{t('reviews.title')}</h1>
      <p>{t('reviews.neutral')}</p>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {admin && settings && (
        <Surface className="space-y-4 p-5">
          <h2 className="text-xl font-bold">{t('reviews.settings')}</h2>
          <label className="flex min-h-11 items-center gap-3">
            <input
              type="checkbox"
              checked={settings.enabled}
              disabled={busy}
              onChange={(e) => setSettings({ ...settings, enabled: e.target.checked })}
            />
            {t('reviews.enabled')}
          </label>
          <Field label={t('reviews.url')} hint={t('reviews.urlHint')}>
            <Input
              type="url"
              value={settings.googleUrl ?? ''}
              maxLength={600}
              onChange={(e) => setSettings({ ...settings, googleUrl: e.target.value || null })}
            />
          </Field>
          <Field label={t('reviews.cooldown')}>
            <Input
              type="number"
              min={30}
              max={365}
              value={settings.cooldownDays}
              onChange={(e) => setSettings({ ...settings, cooldownDays: Number(e.target.value) })}
            />
          </Field>
          <p>{t('reviews.settingsHint')}</p>
          {!settings.deliveryAvailable && <p>{t('reviews.deliveryOff')}</p>}
          <Button
            disabled={busy}
            onClick={() =>
              void work(async () => {
                const r = await api.request('PUT', '/review-settings', {
                  schema: ReviewSettings,
                  body: {
                    version: settings.version,
                    enabled: settings.enabled,
                    googleUrl: settings.googleUrl,
                    cooldownDays: settings.cooldownDays,
                  },
                });
                setSettings(r);
                setNotice(t('reviews.saved'));
              })
            }
          >
            {t('reviews.save')}
          </Button>
        </Surface>
      )}
      <Surface className="space-y-4 p-5">
        <h2 className="text-xl font-bold">{t('reviews.request')}</h2>
        <p>{t('reviews.eligibility')}</p>
        <Field label={t('reviews.visitDate')}>
          <Input
            type="date"
            value={date}
            disabled={busy || recovering}
            onChange={(e) => {
              setDate(e.target.value);
              setVisits([]);
              setChosen('');
            }}
          />
        </Field>
        <Button
          variant="outline"
          disabled={busy || recovering || !date}
          onClick={() =>
            void work(async () => {
              const r = await api.request('GET', '/appointments', {
                schema: AppointmentList,
                query: { date },
              });
              setVisits(r.data.filter((v) => v.status === 'completed'));
              setChosen('');
            })
          }
        >
          {t('reviews.loadVisits')}
        </Button>
        <Field label={t('reviews.visit')}>
          <NativeSelect
            disabled={busy || recovering}
            value={chosen}
            onChange={(e) => setChosen(e.target.value)}
          >
            <option value="">{t('reviews.choose')}</option>
            {visits.map((v) => (
              <option key={v.id} value={v.id}>
                {v.patient.name} ·{' '}
                {new Date(v.startAt).toLocaleTimeString(locale === 'hi' ? 'hi-IN' : 'en-IN', {
                  hour: '2-digit',
                  minute: '2-digit',
                  timeZone: 'Asia/Kolkata',
                })}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Button disabled={busy || (!chosen && !recovering)} onClick={() => void request()}>
          {recovering ? t('reviews.retry') : t('reviews.request')}
        </Button>
        {recovering && <p>{t('reviews.retryHint')}</p>}
      </Surface>
      <Surface className="space-y-4 p-5">
        <h2 className="text-xl font-bold">{t('reviews.tracking')}</h2>
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-5">
          {(['total', 'accepted', 'sent', 'delivered', 'opened'] as const).map((k) => (
            <div key={k}>
              <dt>{t(`reviews.metric.${k}`)}</dt>
              <dd className="text-xl font-bold">{metrics[k]}</dd>
            </div>
          ))}
        </dl>
        <p>{t('reviews.metricsHint')}</p>
        <Button variant="outline" disabled={busy} onClick={() => void work(() => load())}>
          {t('reviews.refresh')}
        </Button>
      </Surface>
      {rows.map((r) => (
        <Surface key={r.id} className="space-y-3 p-5">
          <h3 className="font-bold">{r.patientName}</h3>
          <p>
            {t('reviews.status')}: {t(`delivery.state.${r.status}`)}
          </p>
          <p>
            {new Date(r.createdAt).toLocaleString(locale === 'hi' ? 'hi-IN' : 'en-IN', {
              timeZone: 'Asia/Kolkata',
            })}
          </p>
          {r.openedAt && <p>{t('reviews.opened')}</p>}
          {r.cancelled ? (
            <p>{t('reviews.cancelled')}</p>
          ) : (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                void work(async () => {
                  await api.request('POST', `/review-requests/${r.id}/cancel`, {
                    schema: ReviewRequest,
                  });
                  await load();
                })
              }
            >
              {t('reviews.cancel')}
            </Button>
          )}
        </Surface>
      ))}
      {!rows.length && <p>{t('reviews.empty')}</p>}
      {cursor && (
        <Button disabled={busy} onClick={() => void work(() => load(cursor))}>
          {t('reviews.more')}
        </Button>
      )}
    </section>
  );
}
