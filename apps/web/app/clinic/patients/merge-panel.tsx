'use client';

import { ApiError } from '@dhc/api-client';
import {
  PatientListResponse,
  PatientMergeRequest,
  type PatientDetail,
  type PatientSummary,
} from '@dhc/contracts';
import { Button, Field, Input } from '@dhc/ui-web';
import { useState, type FormEvent } from 'react';
import { useSession } from '../session-provider';

/**
 * Asks a clinic admin to merge a duplicate record. Staff find the other record, choose
 * which one stays, and say why; nothing changes until the admin approves.
 */
export function MergePanel({
  patient,
  onRequested,
}: {
  patient: PatientDetail;
  onRequested: () => void;
}) {
  const { api, signOut, t } = useSession();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PatientSummary[] | null>(null);
  const [other, setOther] = useState<PatientSummary | null>(null);
  const [keep, setKeep] = useState<'this' | 'other'>('this');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const fail = (e: unknown) => {
    if (e instanceof ApiError && e.status === 401) return void signOut('expired');
    setError(e instanceof ApiError ? e.message : t('error.network'));
  };

  async function search(event: FormEvent) {
    event.preventDefault();
    const q = query.trim();
    if (!q) return;
    setError(null);
    try {
      const found = await api.request('GET', '/patients', {
        schema: PatientListResponse,
        query: { q, limit: 8 },
      });
      setResults(found.data.filter((p) => p.id !== patient.id && !p.mergedIntoId));
    } catch (e) {
      fail(e);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!other) return;
    const reason = String(new FormData(event.currentTarget).get('reason') ?? '');
    setBusy(true);
    setError(null);
    try {
      await api.request('POST', '/patient-merges', {
        schema: PatientMergeRequest,
        body: {
          sourcePatientId: keep === 'this' ? other.id : patient.id,
          targetPatientId: keep === 'this' ? patient.id : other.id,
          reason,
        },
      });
      setOpen(false);
      onRequested();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <Button type="button" variant="outline" onClick={() => setOpen(true)}>
        {t('merge.start')}
      </Button>
    );
  }

  return (
    <div className="grid gap-4" data-testid="merge-panel">
      <p className="text-sm text-muted-foreground">{t('merge.hint')}</p>
      {!other && (
        <form role="search" className="flex flex-wrap items-end gap-3" onSubmit={search}>
          <div className="w-full sm:w-80">
            <Field label={t('merge.find')}>
              <Input type="search" value={query} onChange={(e) => setQuery(e.target.value)} />
            </Field>
          </div>
          <Button type="submit" variant="outline">
            {t('merge.search')}
          </Button>
        </form>
      )}
      {!other && results && results.length === 0 && (
        <p className="text-sm text-muted-foreground">{t('merge.noResults')}</p>
      )}
      {!other && results && results.length > 0 && (
        <ul className="m-0 grid list-none gap-2 p-0">
          {results.map((p) => (
            <li key={p.id}>
              <Button type="button" variant="outline" onClick={() => setOther(p)}>
                {t('merge.choose', { name: p.name, uhid: p.uhid })}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {other && (
        <form aria-label={t('merge.formTitle')} className="grid gap-4" onSubmit={submit}>
          <fieldset className="m-0 grid gap-2 border-0 p-0">
            <legend className="mb-1 text-sm font-semibold">{t('merge.keepWhich')}</legend>
            {(
              [
                ['this', patient],
                ['other', other],
              ] as const
            ).map(([value, p]) => (
              <label key={value} className="flex min-h-11 items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="keep"
                  className="size-4"
                  checked={keep === value}
                  onChange={() => setKeep(value)}
                />
                {t('merge.keep', { name: p.name, uhid: p.uhid })}
              </label>
            ))}
          </fieldset>
          <p className="rounded-xl bg-warning-soft px-4 py-3 text-sm text-warning-foreground">
            {t('merge.warning', {
              duplicate: keep === 'this' ? other.uhid : patient.uhid,
              kept: keep === 'this' ? patient.uhid : other.uhid,
            })}
          </p>
          <div className="sm:w-96">
            <Field label={t('merge.reason')} hint={t('merge.reasonHint')}>
              <Input name="reason" required maxLength={300} />
            </Field>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy}>
              {t('merge.send')}
            </Button>
            <Button type="button" variant="outline" onClick={() => setOther(null)}>
              {t('merge.chooseAnother')}
            </Button>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              {t('common.cancel')}
            </Button>
          </div>
        </form>
      )}
      {error && (
        <p role="alert" className="rounded-xl bg-danger-soft px-4 py-3 text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
