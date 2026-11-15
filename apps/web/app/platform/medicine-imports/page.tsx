'use client';

import { ApiError } from '@dhc/api-client';
import {
  ClinicalMapping,
  ImportBrandList,
  ImportGenericList,
  ImportMappingHistory,
  ImportReleaseList,
  MedicineRoute,
  type ImportGeneric,
  type ImportReviewStatus,
  type ImportReleaseSummary,
} from '@dhc/contracts';
import { Button, Input, PageHeader, Surface } from '@dhc/ui-web';
import { useCallback, useEffect, useState } from 'react';
import { PlatformShell, ErrorNotice } from '../shell';
import { usePlatformSession } from '../session-provider';
import { MoleculePicker } from './molecule-picker';

export default function ImportsPage() {
  return <PlatformShell>{() => <Imports />}</PlatformShell>;
}
function Imports() {
  const { api, t, signOut } = usePlatformSession();
  const [releases, setReleases] = useState<ImportReleaseSummary[]>([]);
  const [releaseCursor, setReleaseCursor] = useState<string | null>(null);
  const [release, setRelease] = useState<ImportReleaseSummary | null>(null);
  const [rows, setRows] = useState<ImportGeneric[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<ImportReviewStatus>('all');
  const [applied, setApplied] = useState({ q: '', status: 'all' as ImportReviewStatus });
  const [selected, setSelected] = useState<ImportGeneric | null>(null);
  const [mapping, setMapping] = useState<ClinicalMapping | null>(null);
  const [brands, setBrands] = useState<ImportBrandList['data']>([]);
  const [brandCursor, setBrandCursor] = useState<string | null>(null);
  const [history, setHistory] = useState<ImportMappingHistory['data']>([]);
  const [historyCursor, setHistoryCursor] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const edit = (patch: Partial<ClinicalMapping>) =>
    setMapping((old) =>
      old
        ? {
            ...old,
            ...patch,
            decision: 'draft',
            reviewAttested: false,
          }
        : old,
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
  const loadReleases = useCallback(
    async (after?: string) => {
      const result = await api.request('GET', '/platform/medicine-imports', {
        schema: ImportReleaseList,
        query: after ? { cursor: after } : {},
      });
      setReleases((old) => (after ? [...old, ...result.data] : result.data));
      setReleaseCursor(result.nextCursor);
    },
    [api],
  );
  useEffect(() => {
    let live = true;
    setBusy(true);
    void loadReleases()
      .catch((e) => {
        if (live) fail(e);
      })
      .finally(() => {
        if (live) setBusy(false);
      });
    return () => {
      live = false;
    };
  }, [loadReleases, fail]);
  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await fn();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  const listGenerics = async (
    r: ImportReleaseSummary,
    after?: string,
    filters = after ? applied : { q, status },
  ) => {
    const result = await api.request('GET', `/platform/medicine-imports/${r.id}/generics`, {
      schema: ImportGenericList,
      query: { ...(after ? { cursor: after } : {}), q: filters.q, status: filters.status },
    });
    setApplied(filters);
    setRelease(r);
    setRows((old) => (after ? [...old, ...result.data] : result.data));
    setCursor(result.nextCursor);
    if (!after) {
      setSelected(null);
      setMapping(null);
      setBrands([]);
      setHistory([]);
    }
  };
  const base = selected
    ? `/platform/medicine-imports/${selected.releaseId}/generics/${selected.sourceId}`
    : '';
  const select = async (row: ImportGeneric) => {
    const prefix = `/platform/medicine-imports/${row.releaseId}/generics/${row.sourceId}`;
    const [b, h] = await Promise.all([
      api.request('GET', prefix + '/brands', { schema: ImportBrandList }),
      api.request('GET', prefix + '/history', { schema: ImportMappingHistory }),
    ]);
    setSelected(row);
    setBrands(b.data);
    setBrandCursor(b.nextCursor);
    setHistory(h.data);
    setHistoryCursor(h.nextBefore);
    setMapping(
      row.mapping ?? {
        form: null,
        route: null,
        ingredients: row.source.ingredients.map((i) => ({
          sourceId: i.sourceId,
          moleculeId: null,
          canonicalName: i.name.length <= 200 ? i.name : null,
          strengthStatus: 'unmapped',
          value: null,
          unit: null,
          per: null,
          reason: null,
        })),
        regulatoryEvidence: null,
        notes: '',
        decision: 'draft',
        reviewerName: null,
        reviewerRegistration: null,
        reviewAttested: false,
      },
    );
  };
  const save = async () => {
    if (!selected || !mapping) return;
    const value = ClinicalMapping.safeParse(mapping);
    if (!value.success) {
      setError(t('medicineImport.invalid'));
      return;
    }
    const result = await api.request('PUT', base + '/mapping', {
      schema: ImportGenericList.shape.data.element,
      body: { revision: selected.revision, mapping: value.data },
    });
    setRows((old) =>
      old.flatMap((r) => {
        if (r.sourceId !== result.sourceId) return [r];
        return applied.status === 'all' || applied.status === result.mapping?.decision
          ? [result]
          : [];
      }),
    );
    await select(result);
    setSaved(true);
  };
  return (
    <div className="space-y-6">
      <PageHeader title={t('medicineImport.title')} sub={t('medicineImport.scope')} />
      <Surface className="space-y-3 p-5">
        <p className="font-semibold">
          {t(
            release?.licenceStatus === 'recorded'
              ? 'medicineImport.licenceRecorded'
              : 'medicineImport.pending',
          )}
        </p>
        <p>{t('medicineImport.limit')}</p>
        <h2 className="font-bold">{t('medicineImport.releases')}</h2>
        {!releases.length && !busy ? <p>{t('medicineImport.empty')}</p> : null}
        {releases.map((r) => (
          <div key={r.id} className="flex flex-wrap items-center gap-3 border-b py-2">
            <span>
              {r.datasetKey} / {r.sourceVersion} · {r.dataKind} · {r.brandCount}{' '}
              {t('medicineImport.brands')} · {r.genericCount} {t('medicineImport.generics')} ·{' '}
              {r.issueCount} {t('medicineImport.issues')}
            </span>
            <Button
              disabled={busy}
              onClick={() =>
                void run(() => {
                  setQ('');
                  setStatus('all');
                  return listGenerics(r, undefined, { q: '', status: 'all' });
                })
              }
            >
              {t('medicineImport.open')}
            </Button>
          </div>
        ))}
        {releaseCursor ? (
          <Button disabled={busy} onClick={() => void run(() => loadReleases(releaseCursor))}>
            {t('medicineImport.more')}
          </Button>
        ) : null}
      </Surface>
      <ErrorNotice message={error} />
      <p role="status">{saved ? t('medicineImport.saved') : busy ? t('common.loading') : ''}</p>
      {release ? (
        <Surface className="space-y-3 p-5">
          <h2 className="font-bold">
            {release.datasetKey} / {release.sourceVersion}
          </h2>
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void run(() => listGenerics(release));
            }}
          >
            <label>
              {t('medicineImport.search')}
              <Input
                value={q}
                maxLength={100}
                disabled={busy}
                onChange={(e) => setQ(e.target.value)}
              />
            </label>
            <label>
              {t('medicineImport.reviewFilter')}
              <select
                className="block rounded border p-2"
                value={status}
                disabled={busy}
                onChange={(e) => setStatus(e.target.value as ImportReviewStatus)}
              >
                <option value="all">{t('medicineImport.allMappings')}</option>
                <option value="untouched">{t('medicineImport.untouched')}</option>
                <option value="draft">{t('medicineImport.draft')}</option>
                <option value="review_recorded">{t('medicineImport.recorded')}</option>
              </select>
            </label>
            <Button disabled={busy} type="submit">
              {t('common.search')}
            </Button>
          </form>
          {rows.map((r) => (
            <div key={r.sourceId} className="flex flex-wrap items-center gap-3 border-b py-2">
              <span>
                {r.name} · {r.sourceId} ·{' '}
                {r.mapping?.decision === 'review_recorded'
                  ? t('medicineImport.recorded')
                  : r.mapping
                    ? t('medicineImport.draft')
                    : t('medicineImport.untouched')}{' '}
                · {r.revision}
              </span>
              <Button disabled={busy} onClick={() => void run(() => select(r))}>
                {t('medicineImport.map')}
              </Button>
            </div>
          ))}
          {!rows.length ? <p>{t('medicineImport.noResults')}</p> : null}
          {cursor ? (
            <Button disabled={busy} onClick={() => void run(() => listGenerics(release, cursor))}>
              {t('medicineImport.more')}
            </Button>
          ) : null}
        </Surface>
      ) : null}
      {selected && mapping ? (
        <Surface className="space-y-4 p-5">
          <h2 className="text-xl font-bold">{selected.name}</h2>
          <p>
            {t('medicineImport.sourceForm')}: {selected.source.form.name} ·{' '}
            {selected.source.form.sourceId}
          </p>
          <p>
            {t('medicineImport.sourceRoutes')}:{' '}
            {selected.source.routes.map((r) => `${r.name} (${r.sourceId})`).join(', ')}
          </p>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void run(save);
            }}
          >
            <fieldset disabled={busy} className="space-y-4">
              <label className="block">
                {t('medicineImport.form')}
                <Input
                  maxLength={40}
                  value={mapping.form ?? ''}
                  onChange={(e) => edit({ form: e.target.value || null })}
                />
              </label>
              <label className="block">
                {t('medicineImport.route')}
                <select
                  className="block rounded border p-2"
                  value={mapping.route ?? ''}
                  onChange={(e) =>
                    edit({
                      route: e.target.value ? MedicineRoute.parse(e.target.value) : null,
                    })
                  }
                >
                  <option value="">{t('medicineImport.unmapped')}</option>
                  {MedicineRoute.options.map((r) => (
                    <option key={r} value={r}>
                      {t(`rx.route.${r}`)}
                    </option>
                  ))}
                </select>
              </label>
              {mapping.ingredients.map((i, index) => {
                const update = (patch: Partial<typeof i>) =>
                  edit({
                    ingredients: mapping.ingredients.map((old, j) =>
                      index === j ? { ...old, ...patch } : old,
                    ),
                  });
                return (
                  <fieldset key={i.sourceId} className="space-y-3 rounded border p-4">
                    <legend>
                      {selected.source.ingredients.find((s) => s.sourceId === i.sourceId)?.name} ·{' '}
                      {i.sourceId}
                    </legend>
                    <label className="block">
                      {t('medicineImport.ingredient')}
                      <Input
                        value={i.canonicalName ?? ''}
                        maxLength={200}
                        onChange={(e) =>
                          update({ canonicalName: e.target.value || null, moleculeId: null })
                        }
                      />
                    </label>
                    <MoleculePicker
                      key={`${selected.releaseId}:${selected.sourceId}:${i.sourceId}`}
                      sourceName={
                        selected.source.ingredients.find((s) => s.sourceId === i.sourceId)!.name
                      }
                      selectedId={i.moleculeId}
                      selectedName={i.canonicalName}
                      onSelect={(id, name) => update({ moleculeId: id, canonicalName: name })}
                    />
                    <label className="block">
                      {t('medicineImport.strengthState')}
                      <select
                        className="block rounded border p-2"
                        value={i.strengthStatus}
                        onChange={(e) =>
                          update({
                            strengthStatus: e.target.value as typeof i.strengthStatus,
                            value: null,
                            unit: null,
                            per: null,
                          })
                        }
                      >
                        <option value="unmapped">{t('medicineImport.unmapped')}</option>
                        <option value="mapped">{t('medicineImport.mapped')}</option>
                        <option value="not_applicable">{t('medicineImport.notApplicable')}</option>
                      </select>
                    </label>
                    {i.strengthStatus === 'mapped' ? (
                      <div className="flex flex-wrap gap-3">
                        <label>
                          {t('medicineImport.value')}
                          <Input
                            type="number"
                            min="0.000001"
                            max="1000000"
                            step="any"
                            value={i.value ?? ''}
                            onChange={(e) =>
                              update({ value: e.target.value ? Number(e.target.value) : null })
                            }
                          />
                        </label>
                        <label>
                          {t('medicineImport.unit')}
                          <select
                            className="block rounded border p-2"
                            value={i.unit ?? ''}
                            onChange={(e) =>
                              update({ unit: (e.target.value as typeof i.unit) || null, per: null })
                            }
                          >
                            <option value="">—</option>
                            {['mg', 'g', 'microgram', 'IU', 'percent'].map((u) => (
                              <option key={u} value={u}>
                                {u === 'percent' ? '%' : u}
                              </option>
                            ))}
                          </select>
                        </label>
                        {i.unit !== 'percent' ? (
                          <label>
                            {t('medicineImport.per')}
                            <select
                              className="block rounded border p-2"
                              value={i.per ?? ''}
                              onChange={(e) =>
                                update({ per: (e.target.value as typeof i.per) || null })
                              }
                            >
                              <option value="">—</option>
                              <option value="unit">{t('medicineImport.perUnit')}</option>
                              <option value="ml">{t('medicineImport.perMl')}</option>
                            </select>
                          </label>
                        ) : null}
                      </div>
                    ) : null}
                    <label className="block">
                      {t('medicineImport.reason')}
                      <Input
                        maxLength={1000}
                        value={i.reason ?? ''}
                        onChange={(e) => update({ reason: e.target.value || null })}
                      />
                    </label>
                    {i.unit === 'percent' ? <p>{t('medicineImport.percentHint')}</p> : null}
                  </fieldset>
                );
              })}
              <label className="block">
                {t('medicineImport.evidence')}
                <textarea
                  className="block w-full rounded border p-2"
                  maxLength={2000}
                  value={mapping.regulatoryEvidence ?? ''}
                  onChange={(e) => edit({ regulatoryEvidence: e.target.value || null })}
                />
              </label>
              <label className="block">
                {t('medicineImport.notes')}
                <textarea
                  className="block w-full rounded border p-2"
                  maxLength={2000}
                  value={mapping.notes}
                  onChange={(e) => edit({ notes: e.target.value })}
                />
              </label>
              <label className="block">
                {t('medicineImport.reviewer')}
                <Input
                  maxLength={200}
                  value={mapping.reviewerName ?? ''}
                  onChange={(e) => edit({ reviewerName: e.target.value || null })}
                />
              </label>
              <label className="block">
                {t('medicineImport.registration')}
                <Input
                  maxLength={200}
                  value={mapping.reviewerRegistration ?? ''}
                  onChange={(e) => edit({ reviewerRegistration: e.target.value || null })}
                />
              </label>
              <p>{t('medicineImport.registrationHint')}</p>
              <label className="block">
                <input
                  type="checkbox"
                  checked={mapping.reviewAttested}
                  onChange={(e) => setMapping({ ...mapping, reviewAttested: e.target.checked })}
                />{' '}
                {t('medicineImport.attest')}
              </label>
              <label className="block">
                {t('medicineImport.decision')}
                <select
                  className="block rounded border p-2"
                  value={mapping.decision}
                  onChange={(e) =>
                    setMapping({
                      ...mapping,
                      decision: e.target.value as ClinicalMapping['decision'],
                    })
                  }
                >
                  <option value="draft">{t('medicineImport.draft')}</option>
                  <option value="review_recorded">{t('medicineImport.recorded')}</option>
                </select>
              </label>
              <Button type="submit">{t('common.save')}</Button>
            </fieldset>
          </form>
          <h3 className="font-bold">{t('medicineImport.brands')}</h3>
          {brands.map((b) => (
            <p key={b.sourceId}>
              {b.name} · {b.sourceId} · {b.supplier.name} · {b.regulatoryStatus}
            </p>
          ))}
          {brandCursor ? (
            <Button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const b = await api.request('GET', base + '/brands', {
                    schema: ImportBrandList,
                    query: { cursor: brandCursor },
                  });
                  setBrands((old) => [...old, ...b.data]);
                  setBrandCursor(b.nextCursor);
                })
              }
            >
              {t('medicineImport.more')}
            </Button>
          ) : null}
          <h3 className="font-bold">{t('medicineImport.history')}</h3>
          {history.map((h) => (
            <details key={h.revision}>
              <summary>
                {h.revision} · {h.recordedBy} · {h.recordedAt}
              </summary>
              <p>
                {h.mapping.form} · {h.mapping.route} · {h.mapping.reviewerName} ·{' '}
                {h.mapping.reviewerRegistration}
              </p>
              {h.mapping.ingredients.map((i) => (
                <p key={i.sourceId}>
                  {i.canonicalName} · {i.value} {i.unit}
                  {i.per ? ` / ${i.per}` : ''} · {i.reason}
                </p>
              ))}
              <p>{h.mapping.regulatoryEvidence}</p>
              <p>{h.mapping.notes}</p>
            </details>
          ))}
          {historyCursor ? (
            <Button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const h = await api.request('GET', base + '/history', {
                    schema: ImportMappingHistory,
                    query: { before: String(historyCursor) },
                  });
                  setHistory((old) => [...old, ...h.data]);
                  setHistoryCursor(h.nextBefore);
                })
              }
            >
              {t('medicineImport.more')}
            </Button>
          ) : null}
        </Surface>
      ) : null}
    </div>
  );
}
