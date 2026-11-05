'use client';
import { useCallback, useEffect, useState } from 'react';
import type { ApiClient } from '@dhc/api-client';
import { RightsList, RightsItem, RightsReviewers, type RightsItem as Item } from '@dhc/contracts';
import type { MessageKey } from '@dhc/i18n';
import { Button, Input, Textarea } from '@dhc/ui-web';
type T = (key: MessageKey, params?: Record<string, string | number>) => string;
const open = (r: Item) =>
  ['requested', 'in_review'].includes(r.state) && ['correction', 'erasure'].includes(r.kind);
export function RightsQueue({
  api,
  t,
  role,
}: {
  api: ApiClient;
  t: T;
  role: 'patient' | 'doctor' | 'clinic_admin';
}) {
  const [rows, setRows] = useState<Item[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const load = useCallback(
    async (next?: string) => {
      setBusy(true);
      setError('');
      try {
        const r = await api.request('GET', '/data-rights', {
          schema: RightsList,
          query: { cursor: next },
        });
        setRows((old) => (next ? [...old, ...r.data] : r.data));
        setCursor(r.nextCursor);
      } catch (e) {
        setError(e instanceof Error ? e.message : t('dataRights.failed'));
      } finally {
        setBusy(false);
      }
    },
    [api, t],
  );
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <section className="space-y-4">
      <h2 className="font-display text-xl font-bold">{t('dataRights.requests')}</h2>
      <Button variant="outline" disabled={busy} onClick={() => void load()}>
        {t('dataRights.refresh')}
      </Button>
      {error && <p role="alert">{error}</p>}
      {!rows.length && !busy && <p>{t('dataRights.none')}</p>}
      {rows.map((r) => (
        <RequestCard key={r.id} r={r} api={api} t={t} role={role} saved={() => load()} />
      ))}
      {cursor && (
        <Button disabled={busy} onClick={() => void load(cursor)}>
          {t('dataRights.more')}
        </Button>
      )}
    </section>
  );
}
function RequestCard({
  r,
  api,
  t,
  role,
  saved,
}: {
  r: Item;
  api: ApiClient;
  t: T;
  role: 'patient' | 'doctor' | 'clinic_admin';
  saved: () => Promise<void>;
}) {
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [response, setResponse] = useState(''),
    [state, setState] = useState('in_review'),
    [policy, setPolicy] = useState(''),
    [evidence, setEvidence] = useState(''),
    [doctors, setDoctors] = useState<{ id: string; name: string | null }[]>([]),
    [doctor, setDoctor] = useState('');
  useEffect(() => {
    if (role === 'clinic_admin' && r.area === 'clinical' && open(r))
      void api
        .request('GET', '/data-rights/reviewers', { schema: RightsReviewers })
        .then((x) => setDoctors(x.data))
        .catch(() => setError(t('dataRights.failed')));
  }, [api, role, r.area, r.kind, r.state, t]);
  async function act(path: string, body: unknown) {
    setBusy(true);
    setError('');
    try {
      await api.request('POST', `/data-rights/${r.id}/${path}`, { schema: RightsItem, body });
      await saved();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('dataRights.failed'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <article className="surface space-y-3 p-4 break-words">
      <h3 className="font-semibold">
        {r.patient?.name ?? t('dataRights.account')} · {t(`dataRights.${r.kind}` as MessageKey)} ·{' '}
        {t(`dataRights.${r.area}` as MessageKey)}
      </h3>
      <p>
        {t('dataRights.reference')}: {r.id}
      </p>
      <p>
        {t('dataRights.status')}: {t(`dataRights.${r.state}` as MessageKey)}
      </p>
      {r.details ? (
        <div className="whitespace-pre-wrap text-sm">
          {typeof r.details.field === 'string' && (
            <p>
              {t('dataRights.field')}: {t(`dataRights.field.${r.details.field}` as MessageKey)} →{' '}
              {String(r.details.value)}
            </p>
          )}
          <p>{String(r.details.message ?? r.details.retention ?? '')}</p>
          {typeof r.details.referenceId === 'string' && (
            <p>
              {t('dataRights.recordReference')}: {r.details.referenceId}
            </p>
          )}
        </div>
      ) : (
        <p>{t('dataRights.clinicalRestricted')}</p>
      )}
      {r.response && <p className="whitespace-pre-wrap">{r.response}</p>}
      {r.policyReference && (
        <p>
          {t('dataRights.policy')}: {r.policyReference}
        </p>
      )}
      {r.evidenceId && (
        <p>
          {t('dataRights.evidence')}: {r.evidenceId}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {role === 'patient' && open(r) && (
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => void act('withdraw', { revision: r.revision })}
        >
          {t('dataRights.withdraw')}
        </Button>
      )}
      {role === 'clinic_admin' && r.area === 'clinical' && open(r) && (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            void act('assign', { revision: r.revision, doctorId: doctor });
          }}
        >
          <label className="block space-y-1">
            {t('dataRights.assign')}
            <select
              className="mt-1 block min-h-11 w-full rounded-xl border border-input bg-card px-3 py-2 text-base"
              required
              value={doctor}
              onChange={(e) => setDoctor(e.target.value)}
            >
              <option value="">{t('dataRights.choose')}</option>
              {doctors.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name ?? d.id}
                </option>
              ))}
            </select>
          </label>
          <Button type="submit" disabled={busy}>
            {t('dataRights.assign')}
          </Button>
        </form>
      )}
      {role !== 'patient' && (r.area !== 'clinical' || role === 'doctor') && open(r) && (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void act('decision', {
              revision: r.revision,
              state,
              response,
              policyReference: policy || null,
              reviewAfter: null,
              evidenceId: evidence || null,
            });
          }}
        >
          <label className="block space-y-1">
            {t('dataRights.status')}
            <select
              className="mt-1 block min-h-11 w-full rounded-xl border border-input bg-card px-3 py-2 text-base"
              value={state}
              onChange={(e) => setState(e.target.value)}
            >
              {['in_review', 'fulfilled', 'declined', 'retained'].map((v) => (
                <option key={v} value={v}>
                  {t(`dataRights.${v}` as MessageKey)}
                </option>
              ))}
            </select>
          </label>
          <label className="block space-y-1">
            {t('dataRights.response')}
            <Textarea
              required
              maxLength={1000}
              value={response}
              onChange={(e) => setResponse(e.target.value)}
            />
          </label>
          <label className="block space-y-1">
            {t('dataRights.policy')}
            <Input
              maxLength={120}
              value={policy}
              onChange={(e) => setPolicy(e.target.value)}
              required={state === 'retained'}
            />
          </label>
          <label className="block space-y-1">
            {t('dataRights.evidence')}
            <Input value={evidence} onChange={(e) => setEvidence(e.target.value)} />
          </label>
          <p className="text-sm">{t('dataRights.reviewHelp')}</p>
          <Button type="submit" disabled={busy}>
            {t('dataRights.saveDecision')}
          </Button>
        </form>
      )}
      <details>
        <summary>{t('dataRights.history')}</summary>
        <ul>
          {r.events.map((e, i) => (
            <li key={i}>
              {new Date(e.at).toLocaleString()} · {t(`dataRights.${e.action}` as MessageKey)}
            </li>
          ))}
        </ul>
      </details>
    </article>
  );
}
