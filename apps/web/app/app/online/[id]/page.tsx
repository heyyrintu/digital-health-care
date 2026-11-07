'use client';
import { ONLINE_CONSENT_VERSION, OnlineVisit, OnlineDestination } from '@dhc/contracts';
import { Button, Field, Input, Surface } from '@dhc/ui-web';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { PatientLocaleToggle, usePatientSession } from '../../session-provider';
export default function Page() {
  const { id } = useParams<{ id: string }>(),
    { api, t, status } = usePatientSession(),
    router = useRouter();
  const [value, setValue] = useState<OnlineVisit | null>(null),
    [name, setName] = useState(''),
    [dob, setDob] = useState(''),
    [address, setAddress] = useState(''),
    [guardian, setGuardian] = useState(''),
    [relation, setRelation] = useState(''),
    [agreed, setAgreed] = useState(false),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const base = '/portal/appointments/' + id + '/online';
  function show(r: OnlineVisit) {
    setValue(r);
    setName(r.identity?.name ?? r.patient.name);
    setDob(r.identity?.dob ?? r.patient.dob ?? '');
    setAddress(r.identity?.address ?? '');
    setGuardian(r.identity?.guardianName ?? '');
    setRelation(r.identity?.guardianRelationship ?? '');
    setAgreed(false);
  }
  useEffect(() => {
    if (status === 'signedOut')
      router.replace('/app/login?next=' + encodeURIComponent('/app/online/' + id));
    if (status === 'signedIn')
      api
        .request('GET', base, { schema: OnlineVisit })
        .then(show)
        .catch(() => setError(t('online.error')));
  }, [api, base, t, status, router, id]);
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
    <main className="mx-auto max-w-2xl space-y-5 p-5">
      <div className="flex items-center justify-between">
        <Link className="underline" href="/app/appointments">
          {t('online.back')}
        </Link>
        <PatientLocaleToggle />
      </div>
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
          {!value.patient.dob && (
            <p>
              {t('online.profileDobRequired')}{' '}
              <Link className="underline" href={'/app/family/' + value.patient.id + '/profile'}>
                {t('online.profileDob')}
              </Link>
            </p>
          )}
          <Surface className="space-y-3 p-5">
            <h2 className="text-xl font-bold">{value.doctor.name}</h2>
            <p>
              {value.doctor.qualifications} · {value.doctor.registrationNumber} ·{' '}
              {value.doctor.council}
            </p>
            <p>{value.doctor.verified ? t('online.doctorVerified') : t('online.doctorPending')}</p>
            <p>{t('online.external')}</p>
            {value.provider && (
              <p>
                {t('online.provider')}:{' '}
                {value.provider === 'phone' ? t('online.audio') : value.provider}
              </p>
            )}
            {!value.enabled && <p>{t('online.disabled')}</p>}
            <p>{t('online.joinWindow')}</p>
            <p role="status">{value.consented ? t('online.consentOn') : t('online.consentOff')}</p>
            {value.stale && <p>{t('online.stale')}</p>}
          </Surface>
          <Surface className="space-y-4 p-5">
            <h2 className="text-xl font-bold">{t('online.identity')}</h2>
            <p>{t('online.identityInfo')}</p>
            <Field label={t('online.name')}>
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label={t('online.dob')}>
              <Input type="date" value={dob} onChange={(e) => setDob(e.target.value)} />
            </Field>
            <Field label={t('online.address')}>
              <Input value={address} onChange={(e) => setAddress(e.target.value)} />
            </Field>
            <Field label={t('online.guardian')}>
              <Input value={guardian} onChange={(e) => setGuardian(e.target.value)} />
            </Field>
            <Field label={t('online.relationship')}>
              <Input value={relation} onChange={(e) => setRelation(e.target.value)} />
            </Field>
            <p>{t('online.consentText')}</p>
            <label className="flex min-h-11 items-start gap-3">
              <input
                type="checkbox"
                checked={agreed}
                onChange={(e) => setAgreed(e.target.checked)}
              />
              {t('online.patientAck')}
            </label>
            <Button
              disabled={busy || !agreed || !value.enabled}
              onClick={() =>
                void work(async () =>
                  show(
                    await api.request('PUT', base, {
                      schema: OnlineVisit,
                      body: {
                        version: value.version,
                        consentVersion: ONLINE_CONSENT_VERSION,
                        agreed: true,
                        identity: {
                          name,
                          dob,
                          address,
                          guardianName: guardian || null,
                          guardianRelationship: relation || null,
                          authorityConfirmed: true,
                        },
                      },
                    }),
                  ),
                )
              }
            >
              {t('online.consent')}
            </Button>
            {value.identity && (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void work(async () =>
                    show(
                      await api.request('POST', base + '/withdraw', {
                        schema: OnlineVisit,
                        body: { version: value.version },
                      }),
                    ),
                  )
                }
              >
                {t('online.withdraw')}
              </Button>
            )}
          </Surface>
          <Button
            disabled={busy || !value.joinAvailable}
            onClick={() =>
              void work(async () => {
                const r = await api.request('POST', base + '/join', { schema: OnlineDestination });
                window.location.assign(r.url);
              })
            }
          >
            {t('online.join')}
          </Button>
        </>
      )}
    </main>
  );
}
