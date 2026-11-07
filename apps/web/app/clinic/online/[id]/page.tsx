'use client';
import { OnlineVisit } from '@dhc/contracts';
import { Button, Field, Input, NativeSelect, Surface } from '@dhc/ui-web';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ClinicShell } from '../../shell';
import { useSession } from '../../session-provider';
export default function Page() {
  const { id } = useParams<{ id: string }>();
  return <ClinicShell>{(me) => <Visit id={id} doctor={me.role === 'doctor'} />}</ClinicShell>;
}
function Visit({ id, doctor }: { id: string; doctor: boolean }) {
  const { api, t } = useSession(),
    [value, setValue] = useState<OnlineVisit | null>(null),
    [contact, setContact] = useState(''),
    [confirmed, setConfirmed] = useState(false),
    [method, setMethod] = useState('video'),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const base = '/appointments/' + id + '/online';
  function show(r: OnlineVisit) {
    setValue(r);
    setContact(r.mode === 'video' ? (r.meetingUrl ?? '') : (r.callPhone ?? ''));
    setMethod(r.mode);
    setConfirmed(false);
  }
  useEffect(() => {
    api
      .request('GET', base, { schema: OnlineVisit })
      .then(show)
      .catch(() => setError(t('online.error')));
  }, [api, base, t]);
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
    <div className="mx-auto max-w-2xl space-y-5">
      <h1 className="text-2xl font-bold">{t('online.title')}</h1>
      {error && <p role="alert">{error}</p>}
      <Button
        variant="outline"
        disabled={busy}
        onClick={() =>
          void work(async () => show(await api.request('GET', base, { schema: OnlineVisit })))
        }
      >
        {t('online.refresh')}
      </Button>
      {value && (
        <>
          <h2 className="text-xl font-bold">
            {value.patient.name} · {value.patient.uhid}
          </h2>
          <p>
            {t('online.profileDob')}: {value.patient.dob ?? '—'}
          </p>
          <p role="status">
            {value.verified
              ? t('online.verified')
              : value.consented
                ? t('online.awaitingDoctor')
                : t('online.awaitingPatient')}
          </p>
          {value.stale && <p>{t('online.stale')}</p>}
          <Surface className="space-y-4 p-5">
            <p>{t('online.external')}</p>
            {!value.enabled && <p>{t('online.disabled')}</p>}
            {(value.meetingUrl || value.callPhone) && (
              <a
                className="underline"
                target="_blank"
                rel="noopener noreferrer"
                href={value.meetingUrl ?? 'tel:' + value.callPhone}
              >
                {t('online.openCall')}
              </a>
            )}
            <Field label={value.mode === 'video' ? t('online.meeting') : t('online.phone')}>
              <Input value={contact} onChange={(e) => setContact(e.target.value)} />
            </Field>
            <Button
              disabled={busy}
              onClick={() =>
                void work(async () =>
                  show(
                    await api.request('PUT', base + '/call', {
                      schema: OnlineVisit,
                      body: {
                        version: value.version,
                        meetingUrl: value.mode === 'video' ? contact : null,
                        callPhone: value.mode === 'audio' ? contact : null,
                      },
                    }),
                  ),
                )
              }
            >
              {t('online.saveCall')}
            </Button>
          </Surface>
          {doctor && (
            <Surface className="space-y-4 p-5">
              <h2 className="text-xl font-bold">{t('online.doctorCheck')}</h2>
              {value.identity && (
                <dl className="space-y-2">
                  <dt>{t('online.name')}</dt>
                  <dd>{value.identity.name}</dd>
                  <dt>{t('online.dob')}</dt>
                  <dd>{value.identity.dob}</dd>
                  <dt>{t('online.address')}</dt>
                  <dd>{value.identity.address}</dd>
                  <dt>{t('online.guardian')}</dt>
                  <dd>
                    {value.identity.guardianName ?? '—'} ·{' '}
                    {value.identity.guardianRelationship ?? '—'}
                  </dd>
                </dl>
              )}
              <Field label={t('online.method')}>
                <NativeSelect value={method} onChange={(e) => setMethod(e.target.value)}>
                  <option value="audio">{t('online.audio')}</option>
                  <option value="video">{t('online.video')}</option>
                </NativeSelect>
              </Field>
              <label className="flex min-h-11 items-start gap-3">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                {t('online.doctorAck')}
              </label>
              <Button
                disabled={busy || !confirmed || !value.consented}
                onClick={() =>
                  void work(async () =>
                    show(
                      await api.request('POST', base + '/verify', {
                        schema: OnlineVisit,
                        body: {
                          version: value.version,
                          method,
                          identityConfirmed: true,
                          ageConfirmed: true,
                          guardianConfirmed: true,
                          suitable: true,
                        },
                      }),
                    ),
                  )
                }
              >
                {t('online.verify')}
              </Button>
            </Surface>
          )}
        </>
      )}
    </div>
  );
}
