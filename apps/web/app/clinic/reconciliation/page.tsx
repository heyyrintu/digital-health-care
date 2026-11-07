'use client';
import { ApiError } from '@dhc/api-client';
import {
  ReconOverview,
  ReconDetail,
  ReconIssueList,
  ReconSettlementList,
  ReconReviewReason,
  ReconReviewResult,
  type ReconRun,
  type ReconIssue,
  type ReconSettlement,
} from '@dhc/contracts';
import { Button, PageHeader, Surface } from '@dhc/ui-web';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSession } from '../session-provider';
import { ClinicShell, NotAllowed } from '../shell';
export default function Page() {
  return (
    <ClinicShell>
      {(me) => (me.role === 'clinic_admin' ? <Reconciliation /> : <NotAllowed />)}
    </ClinicShell>
  );
}
function Reconciliation() {
  const { api, t, locale, signOut } = useSession();
  const yesterday = new Date(Date.now() + 330 * 60000 - 86400000).toISOString().slice(0, 10);
  const [from, setFrom] = useState(yesterday),
    [to, setTo] = useState(yesterday),
    [enabled, setEnabled] = useState(false),
    [runs, setRuns] = useState<ReconRun[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [selected, setSelected] = useState<ReconRun | null>(null),
    [issues, setIssues] = useState<ReconIssue[]>([]),
    [settlements, setSettlements] = useState<ReconSettlement[]>([]),
    [issueCursor, setIssueCursor] = useState<string | null>(null),
    [settlementCursor, setSettlementCursor] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [reason, setReason] = useState<ReconReviewReason>('timing_difference');
  const money = (v: number | null) =>
    v === null
      ? '—'
      : new Intl.NumberFormat(locale === 'hi' ? 'hi-IN' : 'en-IN', {
          style: 'currency',
          currency: 'INR',
        }).format(v / 100);
  const failed = useCallback(
    (e: unknown) => {
      if (e instanceof ApiError && e.status === 401) {
        void signOut('expired');
        return;
      }
      setError(e instanceof ApiError ? e.message : t('error.network'));
    },
    [signOut, t],
  );
  const load = useCallback(
    async (next?: string) => {
      const r = await api.request('GET', '/reconciliation/runs', {
        schema: ReconOverview,
        query: { cursor: next, limit: 20 },
      });
      setEnabled(r.enabled);
      setRuns((old) => (next ? [...old, ...r.runs.data] : r.runs.data));
      setCursor(r.runs.nextCursor);
    },
    [api],
  );
  const wanted = useRef<string | null>(null),
    serial = useRef(0);
  const open = useCallback(
    async (id: string, polling = false) => {
      if (polling && wanted.current !== id) return;
      wanted.current = id;
      const version = ++serial.current;
      const d = await api.request('GET', `/reconciliation/runs/${id}`, { schema: ReconDetail });
      const [i, s] = await Promise.all([
        api.request('GET', `/reconciliation/runs/${id}/issues`, { schema: ReconIssueList }),
        api.request('GET', `/reconciliation/runs/${id}/settlements`, {
          schema: ReconSettlementList,
        }),
      ]);
      if (wanted.current !== id || version !== serial.current) return;
      setSelected(d.run);
      setIssues(i.data);
      setIssueCursor(i.nextCursor);
      setSettlements(s.data);
      setSettlementCursor(s.nextCursor);
    },
    [api],
  );
  const action = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (e) {
      failed(e);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void load().catch(failed);
  }, [load, failed]);
  const selectedId = selected?.id,
    waiting =
      selected?.status === 'queued' ||
      selected?.status === 'running' ||
      (selected?.status === 'failed' && selected.attempts < 5);
  useEffect(() => {
    if (!selectedId || !waiting) return;
    let stopped = false,
      pending = false;
    const timer = setInterval(() => {
      if (!stopped && !pending) {
        pending = true;
        void open(selectedId, true)
          .then(() => load())
          .catch(failed)
          .finally(() => {
            pending = false;
          });
      }
    }, 5000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [selectedId, waiting, open, load, failed]);
  return (
    <div className="space-y-6">
      <PageHeader title={t('recon.title')} sub={t('recon.description')} />
      <p>{t('recon.bankHint')}</p>
      {!enabled && <p>{t('recon.disabled')}</p>}
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void action(async () => {
            const r = await api.request('POST', '/reconciliation/runs', {
              schema: ReconDetail,
              body: { id: crypto.randomUUID(), fromDate: from, toDate: to },
            });
            await load();
            await open(r.run.id);
          });
        }}
      >
        <label>
          {t('recon.from')}
          <input
            className="block rounded border p-2"
            type="date"
            required
            max={to}
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <label>
          {t('recon.to')}
          <input
            className="block rounded border p-2"
            type="date"
            required
            min={from}
            max={yesterday}
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </label>
        <Button type="submit" disabled={busy || !enabled}>
          {t('recon.queue')}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() =>
            void action(async () => {
              await load();
              if (selected) await open(selected.id);
            })
          }
        >
          {t('recon.refresh')}
        </Button>
      </form>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <Surface className="space-y-3 p-4">
        <h2>{t('recon.history')}</h2>
        {runs.length === 0 && <p>{t('recon.empty')}</p>}
        {runs.map((r) => (
          <div key={r.id}>
            <Button variant="outline" disabled={busy} onClick={() => void action(() => open(r.id))}>
              {r.fromDate} – {r.toDate} · {r.environment} · {t(`recon.${r.status}`)}
            </Button>
          </div>
        ))}
        {cursor && (
          <Button disabled={busy} onClick={() => void action(() => load(cursor))}>
            {t('recon.more')}
          </Button>
        )}
      </Surface>
      {selected && (
        <section className="space-y-4" aria-label={t('recon.issues')}>
          <h2>
            {selected.fromDate} – {selected.toDate} · {t(`recon.${selected.status}`)}
          </h2>
          {selected.status === 'failed' && (
            <p role="status">
              {t('recon.failure')} ({selected.errorCode})
            </p>
          )}
          {selected.status === 'succeeded' && (
            <>
              <p>
                {t('recon.counts', {
                  events: selected.eventCount,
                  settlements: selected.settlementCount,
                  issues: selected.mismatchCount,
                })}
              </p>
              <p>{t('recon.reviewHint')}</p>
              <div className="flex flex-wrap gap-3">
                {(['settlements', 'issues'] as const).map((kind) => (
                  <Button
                    key={kind}
                    disabled={busy}
                    variant="outline"
                    onClick={() =>
                      void action(async () => {
                        const blob = await api.requestFile(
                          'GET',
                          `/reconciliation/runs/${selected.id}/export/${kind}`,
                          { accept: 'text/csv' },
                        );
                        const url = URL.createObjectURL(blob),
                          link = document.createElement('a');
                        link.href = url;
                        link.download = `reconciliation-${selected.id}-${kind}.csv`;
                        document.body.appendChild(link);
                        link.click();
                        link.remove();
                        setTimeout(() => URL.revokeObjectURL(url), 60000);
                      })
                    }
                  >
                    {t(kind === 'settlements' ? 'recon.exportSettlements' : 'recon.exportIssues')}
                  </Button>
                ))}
              </div>
              <p>{t('recon.exportHint')}</p>

              <label>
                {t('recon.reason')}{' '}
                <select
                  value={reason}
                  onChange={(e) => setReason(ReconReviewReason.parse(e.target.value))}
                >
                  {ReconReviewReason.options.map((r) => (
                    <option key={r} value={r}>
                      {t(`recon.reason.${r}`)}
                    </option>
                  ))}
                </select>
              </label>
              {issues.length === 0 && <p>{t('recon.noIssues')}</p>}
              {issues.map((i) => (
                <Surface key={i.id} className="space-y-2 p-4">
                  <h3>{t(`recon.issue.${i.code}`)}</h3>
                  <p className="break-all">
                    {i.providerReference} {i.settlementId}
                  </p>
                  <p>
                    {t('recon.expected')}: {money(i.expectedPaise)} · {t('recon.reported')}:{' '}
                    {money(i.reportedPaise)}
                  </p>
                  {i.appointmentId && (
                    <Link
                      className="block underline"
                      href={`/clinic/appointments/${i.appointmentId}/bill`}
                    >
                      {t('recon.bill')}
                    </Link>
                  )}
                  {i.reviewedAt ? (
                    <p>
                      {t('recon.reviewed')} ·{' '}
                      {i.reviewReason && t(`recon.reason.${i.reviewReason}`)}
                    </p>
                  ) : (
                    <Button
                      disabled={busy}
                      onClick={() =>
                        void action(async () => {
                          await api.request('POST', `/reconciliation/issues/${i.id}/review`, {
                            schema: ReconReviewResult,
                            body: { reason },
                          });
                          await open(selected.id);
                        })
                      }
                    >
                      {t('recon.acknowledge')}
                    </Button>
                  )}
                </Surface>
              ))}
              {issueCursor && (
                <Button
                  disabled={busy}
                  onClick={() =>
                    void action(async () => {
                      const r = await api.request(
                        'GET',
                        `/reconciliation/runs/${selected.id}/issues`,
                        { schema: ReconIssueList, query: { cursor: issueCursor } },
                      );
                      setIssues((old) => [...old, ...r.data]);
                      setIssueCursor(r.nextCursor);
                    })
                  }
                >
                  {t('recon.more')}
                </Button>
              )}
              <h2>{t('recon.settlements')}</h2>
              {settlements.map((s) => (
                <Surface key={s.id} className="space-y-2 p-4">
                  <h3>
                    {s.settlementId} · {s.status} · {s.chargingBasis}
                  </h3>
                  <p>UTR: {s.utr ?? '—'}</p>
                  <dl className="grid grid-cols-2 gap-2">
                    {(['gross', 'fees', 'tax', 'adjustment', 'net'] as const).map((k) => (
                      <div key={k}>
                        <dt>{t(`recon.${k}`)}</dt>
                        <dd>{money(s[`${k}Paise`])}</dd>
                      </div>
                    ))}
                  </dl>
                </Surface>
              ))}
              {settlementCursor && (
                <Button
                  disabled={busy}
                  onClick={() =>
                    void action(async () => {
                      const r = await api.request(
                        'GET',
                        `/reconciliation/runs/${selected.id}/settlements`,
                        { schema: ReconSettlementList, query: { cursor: settlementCursor } },
                      );
                      setSettlements((old) => [...old, ...r.data]);
                      setSettlementCursor(r.nextCursor);
                    })
                  }
                >
                  {t('recon.more')}
                </Button>
              )}
            </>
          )}
        </section>
      )}
    </div>
  );
}
