'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import {
  RightsPatients,
  RightsCreate,
  RightsItem,
  ClosureView,
  type RightsCreate as Create,
} from '@dhc/contracts';
import { Button, Input, Textarea } from '@dhc/ui-web';
import type { MessageKey } from '@dhc/i18n';
import { usePatientSession, PatientLocaleToggle } from '../session-provider';
import { RightsQueue } from '../../../components/data-rights';
export default function Page() {
  const { api, status, t, signOut } = usePatientSession();
  const [patients, setPatients] = useState<{ id: string; name: string; uhid: string }[]>([]),
    [patient, setPatient] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(''),
    [key, setKey] = useState(0),
    [kind, setKind] = useState<'correction' | 'erasure'>('correction'),
    [area, setArea] = useState<'profile' | 'clinical' | 'financial'>('profile'),
    [field, setField] = useState('name'),
    [value, setValue] = useState(''),
    [message, setMessage] = useState(''),
    [reference, setReference] = useState(''),
    [closure, setClosure] = useState<ClosureView | null>(null),
    [code, setCode] = useState(''),
    [confirmed, setConfirmed] = useState(false),
    [receipt, setReceipt] = useState<ClosureView | null>(null);
  const pending = useRef<Create | null>(null),
    exportId = useRef<string | null>(null),
    closureId = useRef<string | null>(null);
  useEffect(() => {
    if (status === 'signedIn')
      void api
        .request('GET', '/data-rights/patients', { schema: RightsPatients })
        .then((x) => {
          setPatients(x.data);
          setPatient(x.data[0]?.id ?? '');
        })
        .catch((e) => setError(e instanceof Error ? e.message : t('dataRights.failed')));
  }, [api, status, t]);
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('dataRights.failed'));
    } finally {
      setBusy(false);
    }
  }
  async function submit() {
    const body = RightsCreate.parse({
      id: pending.current?.id ?? crypto.randomUUID(),
      patientId: patient,
      kind,
      area,
      field: area === 'profile' && kind === 'correction' ? field : null,
      value: area === 'profile' && kind === 'correction' ? value : null,
      message,
      referenceId: reference || null,
    });
    if (
      pending.current &&
      JSON.stringify({ ...body, id: '' }) !== JSON.stringify({ ...pending.current, id: '' })
    )
      body.id = crypto.randomUUID();
    pending.current = body;
    await api.request('POST', '/data-rights', { schema: RightsItem, body });
    pending.current = null;
    setMessage('');
    setValue('');
    setKey((k) => k + 1);
    setNotice(t('dataRights.submitted'));
  }
  async function download() {
    exportId.current ??= crypto.randomUUID();
    const data = await api.requestFile('POST', '/data-rights/export', {
      body: { id: exportId.current, patientId: patient },
      accept: 'application/zip',
    });
    const url = URL.createObjectURL(data),
      a = document.createElement('a');
    a.href = url;
    a.download = `patient-data-${exportId.current}.zip`;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    exportId.current = null;
    setKey((k) => k + 1);
    setNotice(t('dataRights.downloadReady'));
  }
  return (
    <main className="mx-auto min-h-dvh max-w-3xl space-y-6 p-4 sm:p-8">
      <div className="flex flex-wrap justify-between gap-3">
        <Link className="underline" href="/app">
          {t('dataRights.back')}
        </Link>
        <PatientLocaleToggle />
      </div>
      <h1 className="font-display text-2xl font-bold">{t('dataRights.title')}</h1>
      {receipt ? (
        <section role="status">
          <h2>{t('dataRights.closed')}</h2>
          <p>
            {t('dataRights.reference')}: {receipt.id}
          </p>
          <p>{t('dataRights.closeHelp')}</p>
          <Link className="underline" href="/app/login">
            {t('dataRights.signIn')}
          </Link>
        </section>
      ) : status !== 'signedIn' ? (
        <p>
          <Link className="underline" href="/app/login">
            {t('dataRights.signIn')}
          </Link>
        </p>
      ) : (
        <>
          <p>{t('dataRights.intro')}</p>
          {error && <p role="alert">{error}</p>}
          {notice && <p role="status">{notice}</p>}
          <label className="block space-y-1">
            {t('dataRights.patient')}
            <select
              className="mt-1 block min-h-11 w-full rounded-xl border border-input bg-card px-3 py-2 text-base"
              value={patient}
              onChange={(e) => {
                setPatient(e.target.value);
                exportId.current = null;
              }}
            >
              {patients.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {p.uhid}
                </option>
              ))}
            </select>
          </label>
          <section className="surface space-y-3 p-4">
            <h2 className="font-display text-xl font-bold">{t('dataRights.download')}</h2>
            <p>{t('dataRights.downloadHelp')}</p>
            <Button disabled={busy || !patient} onClick={() => void run(download)}>
              {t('dataRights.download')}
            </Button>
          </section>
          <form
            className="surface space-y-3 p-4"
            onSubmit={(e) => {
              e.preventDefault();
              void run(submit);
            }}
          >
            <h2 className="font-display text-xl font-bold">{t('dataRights.newRequest')}</h2>
            <label className="block space-y-1">
              {t('dataRights.kind')}
              <select
                className="mt-1 block min-h-11 w-full rounded-xl border border-input bg-card px-3 py-2 text-base"
                value={kind}
                onChange={(e) => setKind(e.target.value as typeof kind)}
              >
                <option value="correction">{t('dataRights.correction')}</option>
                <option value="erasure">{t('dataRights.erasure')}</option>
              </select>
            </label>
            <label className="block space-y-1">
              {t('dataRights.area')}
              <select
                className="mt-1 block min-h-11 w-full rounded-xl border border-input bg-card px-3 py-2 text-base"
                value={area}
                onChange={(e) => setArea(e.target.value as typeof area)}
              >
                {['profile', 'clinical', 'financial'].map((v) => (
                  <option key={v} value={v}>
                    {t(`dataRights.${v}` as MessageKey)}
                  </option>
                ))}
              </select>
            </label>
            {area === 'profile' && kind === 'correction' && (
              <>
                <label className="block space-y-1">
                  {t('dataRights.field')}
                  <select
                    className="mt-1 block min-h-11 w-full rounded-xl border border-input bg-card px-3 py-2 text-base"
                    value={field}
                    onChange={(e) => {
                      setField(e.target.value);
                      setValue('');
                    }}
                  >
                    {[
                      'name',
                      'dob',
                      'gender',
                      'email',
                      'address',
                      'language',
                      'emergencyContactName',
                      'emergencyContactPhone',
                    ].map((v) => (
                      <option key={v} value={v}>
                        {t(`dataRights.field.${v}` as MessageKey)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block space-y-1">
                  {t('dataRights.value')}
                  {field === 'gender' || field === 'language' ? (
                    <select
                      className="mt-1 block min-h-11 w-full rounded-xl border border-input bg-card px-3 py-2"
                      required
                      value={value}
                      onChange={(e) => setValue(e.target.value)}
                    >
                      <option value="">{t('dataRights.choose')}</option>
                      {(field === 'gender' ? ['female', 'male', 'other'] : ['en', 'hi']).map(
                        (v) => (
                          <option key={v} value={v}>
                            {t(`${field === 'gender' ? 'gender' : 'language'}.${v}` as MessageKey)}
                          </option>
                        ),
                      )}
                    </select>
                  ) : (
                    <Input
                      required
                      type={
                        field === 'dob'
                          ? 'date'
                          : field === 'email'
                            ? 'email'
                            : field === 'emergencyContactPhone'
                              ? 'tel'
                              : 'text'
                      }
                      maxLength={300}
                      value={value}
                      onChange={(e) => setValue(e.target.value)}
                    />
                  )}
                </label>
              </>
            )}
            <label className="block space-y-1">
              {t('dataRights.message')}
              <Textarea
                required
                maxLength={1000}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
              />
            </label>
            <label className="block space-y-1">
              {t('dataRights.recordReference')}
              <Input value={reference} onChange={(e) => setReference(e.target.value)} />
            </label>
            <p>{t('dataRights.requestHelp')}</p>
            <Button type="submit" disabled={busy || !patient}>
              {t('dataRights.submit')}
            </Button>
          </form>
          <RightsQueue key={key} api={api} t={t} role="patient" />
          <section className="surface space-y-3 p-4">
            <h2 className="font-display text-xl font-bold">{t('dataRights.close')}</h2>
            <p>{t('dataRights.closeHelp')}</p>
            <label className="flex gap-2">
              <input
                className="mt-1 h-5 w-5 shrink-0"
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              {t('dataRights.confirmClose')}
            </label>
            {!closure ? (
              <Button
                variant="destructive"
                disabled={busy || !confirmed}
                onClick={() =>
                  void run(async () => {
                    closureId.current ??= crypto.randomUUID();
                    setClosure(
                      await api.request('POST', '/data-rights/closure', {
                        schema: ClosureView,
                        body: { id: closureId.current },
                      }),
                    );
                  })
                }
              >
                {t('dataRights.sendCode')}
              </Button>
            ) : (
              <form
                className="space-y-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(async () => {
                    const result = await api.request(
                      'POST',
                      `/data-rights/closure/${closure.id}/verify`,
                      { schema: ClosureView, body: { code, confirmed: true } },
                    );
                    setReceipt(result);
                    await signOut('user');
                  });
                }}
              >
                <p>{t('dataRights.codeHelp')}</p>
                <p className="break-all">
                  {t('dataRights.reference')}: {closure.id}
                </p>
                <label className="block space-y-1">
                  {t('dataRights.code')}
                  <Input
                    autoComplete="one-time-code"
                    inputMode="numeric"
                    pattern="[0-9]{6}"
                    required
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                  />
                </label>
                <Button
                  type="submit"
                  variant="destructive"
                  disabled={busy || !confirmed || !closure.ready}
                >
                  {t('dataRights.close')}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    setClosure(null);
                    closureId.current = null;
                    setCode('');
                  }}
                >
                  {t('dataRights.restart')}
                </Button>
              </form>
            )}
          </section>
        </>
      )}
    </main>
  );
}
