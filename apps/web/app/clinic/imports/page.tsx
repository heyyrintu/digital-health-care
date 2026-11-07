'use client';
import { ApiError } from '@dhc/api-client';
import {
  IMPORT_FIELDS,
  PatientImport,
  PatientImportList,
  parseImportCsv,
  type PreviewPatientImport,
} from '@dhc/contracts';
import { Button, Field, Input, NativeSelect, Surface } from '@dhc/ui-web';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { ClinicShell } from '../shell';
import { useSession } from '../session-provider';
export default function Page() {
  return (
    <ClinicShell>
      {(me) =>
        me.role === 'clinic_admin' ? (
          <Imports />
        ) : (
          <p>Clinic admin access required. / क्लिनिक एडमिन की अनुमति चाहिए।</p>
        )
      }
    </ClinicShell>
  );
}
function Imports() {
  const { api, t } = useSession();
  const [source, setSource] = useState(''),
    [csv, setCsv] = useState(''),
    [headers, setHeaders] = useState<string[]>([]),
    [mapping, setMapping] = useState<Record<string, string>>({}),
    [job, setJob] = useState<PatientImport | null>(null),
    [recent, setRecent] = useState<PatientImportList['data']>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [agreed, setAgreed] = useState(false),
    [recovering, setRecovering] = useState(false);
  const attempt = useRef<PreviewPatientImport | null>(null);
  const fail = (e: unknown) =>
    setError(
      e instanceof ApiError ? e.message : e instanceof Error ? e.message : t('imports.error'),
    );
  useEffect(() => {
    api
      .request('GET', '/patient-imports', { schema: PatientImportList })
      .then((r) => setRecent(r.data))
      .catch((e) => setError(e instanceof ApiError ? e.message : t('imports.error')));
  }, [api, t]);
  async function work(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }
  async function file(file: File | undefined) {
    if (!file) return;
    await work(async () => {
      setCsv('');
      setHeaders([]);
      setMapping({});
      setJob(null);
      setAgreed(false);
      attempt.current = null;
      if (file.size > 262144) throw new Error(t('imports.size'));
      const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()),
        head = parseImportCsv(text)[0]!;
      setCsv(text);
      setHeaders(head);
      setMapping(Object.fromEntries(IMPORT_FIELDS.map((f) => [f, head.includes(f) ? f : ''])));
      setJob(null);
      setAgreed(false);
      attempt.current = null;
    });
  }
  function showJob(value: PatientImport) {
    setJob(value);
    setAgreed(false);
    setRecent((old) =>
      [
        { id: value.id, source: value.source, status: value.status, createdAt: value.createdAt },
        ...old.filter((r) => r.id !== value.id),
      ].slice(0, 20),
    );
  }
  async function preview() {
    const b = attempt.current ?? {
      id: crypto.randomUUID(),
      source,
      csv,
      mapping: Object.fromEntries(
        Object.entries(mapping).filter(([, v]) => v),
      ) as PreviewPatientImport['mapping'],
    };
    attempt.current = b;
    setRecovering(true);
    await work(async () => {
      try {
        const r = await api.request('POST', '/patient-imports/preview', {
          schema: PatientImport,
          body: b,
        });
        showJob(r);
        attempt.current = null;
        setRecovering(false);
      } catch (e) {
        if (e instanceof ApiError && [400, 403, 404, 409, 422].includes(e.status)) {
          attempt.current = null;
          setRecovering(false);
        }
        throw e;
      }
    });
  }
  async function action(kind: 'apply' | 'cancel') {
    if (!job) return;
    await work(async () => {
      showJob(
        await api.request('POST', `/patient-imports/${job.id}/${kind}`, {
          schema: PatientImport,
          ...(kind === 'apply' ? { body: { acknowledged: true } } : {}),
        }),
      );
      setAgreed(false);
    });
  }
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <h1 className="text-2xl font-bold">{t('imports.title')}</h1>
      <p>{t('imports.scope')}</p>
      {error && (
        <p role="alert" className="rounded-xl bg-red-50 p-4 text-red-800">
          {error}
        </p>
      )}
      <Surface className="space-y-4 p-5">
        <h2 className="text-xl font-bold">{t('imports.upload')}</h2>
        <p>{t('imports.help')}</p>
        <a
          className="underline"
          href={
            'data:text/csv;charset=utf-8,' +
            encodeURIComponent(
              'externalId,name,phone,dob,gender,email,address,uhid\nLEGACY-001,Synthetic Patient,9876543210,1990-01-02,female,,,OLD1001\n',
            )
          }
          download="patient-import-template.csv"
        >
          {t('imports.template')}
        </a>
        <Field label={t('imports.source')}>
          <Input
            value={source}
            disabled={busy || recovering}
            onChange={(e) => {
              setSource(e.target.value);
              setJob(null);
              setAgreed(false);
            }}
          />
        </Field>
        <Field label={t('imports.file')}>
          <input
            type="file"
            accept=".csv,text/csv"
            disabled={busy || recovering}
            onChange={(e) => void file(e.target.files?.[0])}
          />
        </Field>
        {headers.length > 0 && (
          <fieldset disabled={busy || recovering} className="grid gap-4 sm:grid-cols-2">
            <legend className="mb-3 font-bold">{t('imports.mapping')}</legend>
            {IMPORT_FIELDS.map((f) => (
              <Field key={f} label={t(`imports.${f}`)}>
                <NativeSelect
                  value={mapping[f] ?? ''}
                  onChange={(e) => {
                    setMapping((m) => ({ ...m, [f]: e.target.value }));
                    setJob(null);
                    setAgreed(false);
                  }}
                >
                  <option value="">{t('imports.unmapped')}</option>
                  {headers.map((h) => (
                    <option key={h} value={h}>
                      {h}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            ))}
          </fieldset>
        )}
        <Button
          disabled={
            busy || !csv || !source || !mapping.externalId || !mapping.name || !mapping.phone
          }
          onClick={() => void preview()}
        >
          {recovering ? t('imports.retry') : t('imports.preview')}
        </Button>
      </Surface>
      {job && (
        <Surface className="space-y-4 p-5">
          <h2 className="text-xl font-bold">{t('imports.result')}</h2>
          <p>{job.source}</p>
          <p role="status">
            {t(job.status === 'preview' ? 'imports.previewStatus' : `imports.${job.status}`)} ·{' '}
            {job.newCount} {t('imports.new')} · {job.skippedCount} {t('imports.skipped')} ·{' '}
            {job.errorCount} {t('imports.errors')}
          </p>
          <p>
            {t('imports.expiry')}{' '}
            {new Date(job.expiresAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}
          </p>
          <div className="space-y-3">
            {job.rows.map((r) => (
              <article key={r.row} className="rounded-xl border p-4">
                <p className="font-semibold">
                  {r.row}. {r.name} · {r.externalId}
                </p>
                <p>
                  {r.phone} · {r.dob ?? '—'} · {r.uhid ?? t('imports.automatic')}
                </p>
                <p>
                  {r.gender ?? '—'} · {r.email ?? '—'} · {r.address ?? '—'}
                </p>
                <p>{t(r.state === 'error' ? 'imports.rowError' : `imports.${r.state}`)}</p>
                {r.issues.map((v, i) => (
                  <p className="text-red-800" key={i}>
                    {v}
                  </p>
                ))}
                {r.warnings.map((v, i) => (
                  <p className="text-amber-900" key={i}>
                    {v}
                  </p>
                ))}
                {job.status === 'applied' && r.patientId && (
                  <Link className="underline" href={`/clinic/patients/${r.patientId}`}>
                    {t('imports.openPatient')}
                  </Link>
                )}
              </article>
            ))}
          </div>
          {job.status === 'preview' && (
            <>
              <label className="flex min-h-11 items-start gap-3">
                <input
                  type="checkbox"
                  checked={agreed}
                  disabled={busy || !!job.errorCount}
                  onChange={(e) => setAgreed(e.target.checked)}
                />
                <span>{t('imports.ack')}</span>
              </label>
              <div className="flex flex-wrap gap-3">
                <Button
                  disabled={busy || !!job.errorCount || !agreed}
                  onClick={() => void action('apply')}
                >
                  {t('imports.apply')}
                </Button>
                <Button variant="outline" disabled={busy} onClick={() => void action('cancel')}>
                  {t('imports.cancel')}
                </Button>
              </div>
            </>
          )}
        </Surface>
      )}
      <Surface className="space-y-3 p-5">
        <h2 className="text-xl font-bold">{t('imports.recent')}</h2>
        {recent.map((r) => (
          <div key={r.id}>
            <Button
              variant="outline"
              disabled={busy || recovering}
              onClick={() =>
                void work(async () => {
                  setJob(
                    await api.request('GET', `/patient-imports/${r.id}`, { schema: PatientImport }),
                  );
                  setAgreed(false);
                })
              }
            >
              {r.source} · {new Date(r.createdAt).toLocaleString('en-IN')} ·{' '}
              {t(r.status === 'preview' ? 'imports.previewStatus' : `imports.${r.status}`)}
            </Button>
          </div>
        ))}
      </Surface>
    </div>
  );
}
