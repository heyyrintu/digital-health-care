'use client';

import { ApiError } from '@dhc/api-client';
import {
  MedicineReviewBundle,
  MedicineStageDetail,
  MedicineStageList,
  MedicineSandboxView,
  type MedicineStageSummary,
} from '@dhc/contracts';
import { Button, Input, PageHeader, Surface } from '@dhc/ui-web';
import { useCallback, useEffect, useRef, useState } from 'react';
import { usePlatformSession } from '../session-provider';
import { ErrorNotice, PlatformShell } from '../shell';

export default function MedicinePage() {
  return <PlatformShell>{() => <ReviewScreen />}</PlatformShell>;
}

function ReviewScreen() {
  const { api, t, signOut } = usePlatformSession();
  const [rows, setRows] = useState<MedicineStageSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<MedicineStageDetail | null>(null);
  const [active, setActive] = useState<MedicineStageDetail | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<'saved' | 'uploaded' | null>(null);
  const [note, setNote] = useState('');
  const [ack, setAck] = useState(false);
  const [search, setSearch] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const latest = useRef(0);
  const load = useCallback(
    async (after?: string) => {
      const [list, sandbox] = await Promise.all([
        api.request('GET', '/platform/medicine-stages', {
          schema: MedicineStageList,
          query: after ? { cursor: after } : {},
        }),
        api.request('GET', '/platform/medicine-sandbox', { schema: MedicineSandboxView }),
      ]);
      setRows((old) => (after ? [...old, ...list.data] : list.data));
      setCursor(list.nextCursor);
      setActive(sandbox.stage);
      setReady(true);
    },
    [api],
  );
  const fail = useCallback(
    (e: unknown) => {
      if (e instanceof ApiError && e.status === 401) {
        void signOut('expired');
        return;
      }
      setError(e instanceof Error ? e.message : String(e));
    },
    [signOut],
  );
  useEffect(() => {
    let live = true;
    setBusy(true);
    void load()
      .catch((e) => {
        if (live) fail(e);
      })
      .finally(() => {
        if (live) setBusy(false);
      });
    return () => {
      live = false;
      latest.current++;
    };
  }, [load, fail]);
  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  const choose = async (id: string) => {
    const sequence = ++latest.current;
    const detail = await api.request('GET', `/platform/medicine-stages/${id}`, {
      schema: MedicineStageDetail,
    });
    if (sequence !== latest.current) return;
    setSelected(detail);
    setNote('');
    setAck(false);
    setSearch('');
  };
  const upload = async () => {
    if (!file || file.size > 2 * 1024 * 1024) {
      setError(t('medicineReview.invalid'));
      return;
    }
    let bundle: MedicineReviewBundle;
    try {
      bundle = MedicineReviewBundle.parse(JSON.parse(await file.text()));
    } catch {
      setError(t('medicineReview.invalid'));
      return;
    }
    const detail = await api.request('POST', '/platform/medicine-stages', {
      schema: MedicineStageDetail,
      body: bundle,
    });
    setSelected(detail);
    setNote('');
    setAck(false);
    setSearch('');
    setFile(null);
    if (fileInput.current) fileInput.current.value = '';
    await load();
    setNotice('uploaded');
  };
  const review = async (decision: 'reviewed' | 'rejected') => {
    if (!selected) return;
    const updated = await api.request('POST', `/platform/medicine-stages/${selected.id}/review`, {
      schema: MedicineStageDetail,
      body: { revision: selected.revision, decision, note, scopeAcknowledged: ack },
    });
    setSelected(updated);
    await load();
    setNotice('saved');
  };
  const publish = async () => {
    if (!selected || !ready) return;
    const result = await api.request(
      'POST',
      `/platform/medicine-stages/${selected.id}/publish-sandbox`,
      {
        schema: MedicineSandboxView,
        body: { revision: selected.revision, expectedActiveStageId: active?.id ?? null },
      },
    );
    setSelected(result.stage);
    await load();
    setNotice('saved');
  };
  const records = selected?.bundle.catalogue.records ?? [];
  const filtered = records.filter((r) =>
    `${r.name} ${r.generic.name}`.toLowerCase().includes(search.toLowerCase()),
  );
  const comparable = !active || active.datasetKey === selected?.datasetKey;
  const previous = new Map(
    comparable ? (active?.bundle.catalogue.records.map((r) => [r.sourceId, r]) ?? []) : [],
  );
  const current = new Map(records.map((r) => [r.sourceId, r]));
  const changes = {
    new: records.filter((r) => !previous.has(r.sourceId)).length,
    changed: records.filter(
      (r) =>
        previous.has(r.sourceId) && JSON.stringify(previous.get(r.sourceId)) !== JSON.stringify(r),
    ).length,
    unchanged: records.filter((r) => JSON.stringify(previous.get(r.sourceId)) === JSON.stringify(r))
      .length,
    missing: [...previous.keys()].filter((id) => !current.has(id)).length,
  };
  return (
    <section className="space-y-5" aria-busy={busy}>
      <PageHeader title={t('medicineReview.title')} sub={t('medicineReview.scope')} />
      <ErrorNotice message={error} />
      <p role="status">
        {notice ? t(`medicineReview.${notice}`) : busy ? t('common.loading') : ''}
      </p>
      <Surface className="space-y-3 p-5">
        <h2 className="font-bold">{t('medicineReview.upload')}</h2>
        <label className="block">
          {t('medicineReview.file')}
          <input
            ref={fileInput}
            className="mt-2 block max-w-full"
            type="file"
            accept=".json,application/json"
            disabled={busy}
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </label>
        <Button disabled={busy || !file} onClick={() => void run(upload)}>
          {t('medicineReview.upload')}
        </Button>
        <p>
          {t('medicineReview.active')}:{' '}
          <strong>
            {active ? `${active.datasetKey} / ${active.sourceVersion}` : t('medicineReview.none')}
          </strong>
        </p>
      </Surface>
      <Surface className="space-y-3 p-5">
        <h2 className="font-bold">{t('medicineReview.snapshots')}</h2>
        <Button
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await load();
              if (selected) await choose(selected.id);
            })
          }
        >
          {t('medicineReview.refresh')}
        </Button>
        {ready && !rows.length && <p>{t('medicineReview.empty')}</p>}
        <ul className="space-y-2">
          {rows.map((r) => (
            <li key={r.id}>
              <button
                disabled={busy}
                className="w-full rounded-lg border border-border p-3 text-left disabled:opacity-50"
                aria-pressed={selected?.id === r.id}
                onClick={() => void run(() => choose(r.id))}
              >
                <strong>
                  {r.datasetKey} / {r.sourceVersion}
                </strong>{' '}
                — {t(`medicineReview.${r.state}`)} · {t('medicineReview.candidates')}:{' '}
                {r.candidateCount} · {t('medicineReview.issues')}: {r.issueCount}
              </button>
            </li>
          ))}
        </ul>
        {cursor && (
          <Button disabled={busy} onClick={() => void run(() => load(cursor))}>
            {t('medicineReview.more')}
          </Button>
        )}
      </Surface>
      {selected && (
        <>
          <Surface className="space-y-4 p-5">
            <h2 className="font-bold">
              {selected.datasetKey} / {selected.sourceVersion} —{' '}
              {t(`medicineReview.${selected.state}`)}
            </h2>
            <p>{t('medicineReview.safety')}</p>
            <h3 className="font-semibold">{t('medicineReview.changes')}</h3>
            {!comparable ? (
              <p>{t('medicineReview.notComparable')}</p>
            ) : (
              <ul>
                {(Object.keys(changes) as (keyof typeof changes)[]).map((k) => (
                  <li key={k}>
                    {t(`medicineReview.${k}`)}: {changes[k]}
                  </li>
                ))}
              </ul>
            )}
            <label className="block">
              {t('medicineReview.search')}
              <Input value={search} onChange={(e) => setSearch(e.target.value)} />
            </label>
            <div className="max-h-96 overflow-auto">
              <table className="w-full text-left text-sm">
                <caption className="sr-only">{t('medicineReview.candidates')}</caption>
                <thead>
                  <tr>
                    {(['brand', 'generic', 'ingredients', 'form', 'regulatory'] as const).map(
                      (k) => (
                        <th scope="col" className="p-2" key={k}>
                          {t(`medicineReview.${k}`)}
                        </th>
                      ),
                    )}
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r) => (
                    <tr key={r.sourceId} className="border-t border-border">
                      <td className="p-2">
                        {r.name}
                        <br />
                        <small>{r.sourceId}</small>
                        <details>
                          <summary>{t('medicineReview.details')}</summary>
                          <p>
                            {t('medicineReview.product')}: {r.product.name} ({r.product.sourceId})
                          </p>
                          <p>
                            {t('medicineReview.supplier')}: {r.supplier.name} ({r.supplier.sourceId}
                            )
                          </p>
                          <p>
                            {t('medicineReview.updated')}: {r.sourceUpdatedAt ?? '—'}
                          </p>
                        </details>
                      </td>
                      <td className="p-2">{r.generic.name}</td>
                      <td className="p-2">{r.ingredients.map((i) => i.name).join(', ')}</td>
                      <td className="p-2">
                        {r.form.name} / {r.routes.map((i) => i.name).join(', ')}
                      </td>
                      <td className="p-2">{r.regulatoryStatus}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <details>
              <summary>
                {t('medicineReview.issues')} ({selected.issueCount})
              </summary>
              <ul className="max-h-80 overflow-auto">
                {selected.bundle.report.issues.map((i, n) => (
                  <li className="break-words border-t border-border py-2" key={n}>
                    {i.file} · {t('medicineReview.row')} {i.line} · {i.sourceId} ·{' '}
                    {t('medicineReview.reason')}: {i.reason}
                  </li>
                ))}
              </ul>
              {!selected.issueCount && <p>{t('medicineReview.noissues')}</p>}
            </details>
            <details>
              <summary>{t('medicineReview.provenance')}</summary>
              <p>{t('medicineReview.hashnote')}</p>
              <p className="break-all font-mono text-xs">{selected.fingerprint}</p>
              <ul>
                {Object.entries(selected.bundle.provenance.fileSha256).map(([f, hash]) => (
                  <li className="break-all py-1 text-xs" key={f}>
                    {f}: {hash}
                  </li>
                ))}
              </ul>
            </details>
          </Surface>
          <Surface className="space-y-4 p-5">
            <h2 className="font-bold">{t('medicineReview.review')}</h2>
            {selected.state === 'pending' ? (
              <>
                <label className="block">
                  {t('medicineReview.note')}
                  <textarea
                    className="mt-2 block w-full rounded-lg border border-border bg-card p-3"
                    value={note}
                    minLength={10}
                    maxLength={1000}
                    disabled={busy}
                    onChange={(e) => setNote(e.target.value)}
                  />
                </label>
                <label className="flex gap-2">
                  <input
                    type="checkbox"
                    checked={ack}
                    disabled={busy}
                    onChange={(e) => setAck(e.target.checked)}
                  />
                  {t('medicineReview.ack')}
                </label>
                <div className="flex flex-wrap gap-3">
                  <Button
                    disabled={busy || !ack || note.trim().length < 10}
                    onClick={() => void run(() => review('reviewed'))}
                  >
                    {t('medicineReview.approve')}
                  </Button>
                  <Button
                    disabled={busy || !ack || note.trim().length < 10}
                    onClick={() => void run(() => review('rejected'))}
                  >
                    {t('medicineReview.reject')}
                  </Button>
                </div>
              </>
            ) : (
              <p className="whitespace-pre-wrap break-words">
                {selected.reviewerName} · {selected.reviewedAt}
                <br />
                {selected.reviewNote}
              </p>
            )}
            {['reviewed', 'published_demo'].includes(selected.state) && (
              <Button
                disabled={busy || !ready || active?.id === selected.id}
                onClick={() => void run(publish)}
              >
                {t('medicineReview.publish')}
              </Button>
            )}
          </Surface>
        </>
      )}
    </section>
  );
}
