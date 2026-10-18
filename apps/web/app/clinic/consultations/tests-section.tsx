'use client';

import {
  IMAGING_KINDS,
  MAX_TEST_ORDERS,
  TestCatalogueList,
  type Language,
  type TestCatalogueItem,
  type TestOrder,
  type TestOrderLine,
  type TestSide,
} from '@dhc/contracts';
import { testOrderLabel } from '@dhc/domain';
import { Button, Chip, Input, Label, NativeSelect, cn } from '@dhc/ui-web';
import { Lock, Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useSession } from '../session-provider';

const SIDES: TestSide[] = ['na', 'left', 'right', 'both'];

/** What the prescription save sends for a test (the server keeps status and times). */
export const lineOf = (t: TestOrder): TestOrderLine => ({
  id: t.id,
  catalogueItemId: t.catalogueItemId,
  kind: t.kind,
  name: t.name,
  region: t.region,
  side: t.side,
  views: t.views,
  notes: t.notes?.trim() ? t.notes : null,
});

function newTest(line: Omit<TestOrderLine, 'id'>): TestOrder {
  return {
    ...line,
    id: crypto.randomUUID(),
    status: 'ordered',
    orderedAt: null,
    resultUploadedAt: null,
    reviewedAt: null,
    results: [],
  };
}

const imaging = (kind: TestOrder['kind']) => IMAGING_KINDS.includes(kind);

interface Picking {
  item: TestCatalogueItem;
  region: string;
  side: TestSide;
  views: string[];
}

/**
 * The tests on the prescription draft (PRD §7.1), beside the medicines: search the clinic's
 * catalogue, pick region, side and views for imaging, or add a test that is not listed.
 * Saved with the prescription (same autosave and revision); tests an earlier signed version
 * ordered are locked.
 */
export function TestsSection({
  tests,
  language,
  editable,
  onChange,
}: {
  tests: TestOrder[];
  /** The prescription's language, for the printed wording. */
  language: Language;
  editable: boolean;
  onChange(tests: TestOrder[]): void;
}) {
  const { api, t } = useSession();
  const [catalogue, setCatalogue] = useState<TestCatalogueItem[] | null>(null);
  const [query, setQuery] = useState('');
  const [picking, setPicking] = useState<Picking | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [catalogueFailed, setCatalogueFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!editable) return;
    let current = true;
    setCatalogueFailed(false);
    api
      .request('GET', '/test-catalogue', { schema: TestCatalogueList })
      .then((list) => current && setCatalogue(list.data))
      // Not an empty catalogue: the doctor is told and can try again.
      .catch(() => current && setCatalogueFailed(true));
    return () => {
      current = false;
    };
  }, [api, editable, attempt]);

  const q = query.trim().toLowerCase();
  const matches = useMemo(
    () => (q ? (catalogue ?? []).filter((i) => i.name.toLowerCase().includes(q)) : []),
    [catalogue, q],
  );

  const add = (line: Omit<TestOrderLine, 'id'>) => {
    if (tests.length >= MAX_TEST_ORDERS) {
      setNotice(t('orders.tooMany', { max: MAX_TEST_ORDERS }));
      return;
    }
    setNotice(null);
    onChange([...tests, newTest(line)]);
    setQuery('');
    setPicking(null);
  };

  const choose = (item: TestCatalogueItem) => {
    if (item.regions.length === 0) {
      return add({
        catalogueItemId: item.id,
        kind: item.kind,
        name: item.name,
        region: null,
        side: 'na',
        views: [],
        notes: null,
      });
    }
    setQuery('');
    setPicking({ item, region: '', side: 'na', views: [] });
  };

  const set = (id: string, patch: Partial<TestOrder>) =>
    onChange(tests.map((x) => (x.id === id ? { ...x, ...patch } : x)));

  return (
    <section className="space-y-3 border-t border-border pt-4" data-testid="tests-section">
      <h3 className="font-display text-base font-bold">{t('orders.title')}</h3>
      {notice && <p className="rounded-xl bg-info-soft px-4 py-3 text-sm text-info">{notice}</p>}

      {tests.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-4 text-center text-sm text-muted-foreground">
          {t('orders.empty')}
        </p>
      ) : (
        <ol className="m-0 list-none space-y-2 p-0">
          {tests.map((test, i) => {
            const item = catalogue?.find((c) => c.id === test.catalogueItemId);
            const locked = test.orderedAt !== null || !editable;
            const id = (field: string) => `test-${i}-${field}`;
            return (
              <li
                key={test.id}
                className="space-y-3 rounded-xl border border-border p-3"
                data-testid={`test-line-${i}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <p className="m-0 min-w-0 [overflow-wrap:anywhere]">
                    <span className="font-bold tabular">{i + 1}. </span>
                    <strong data-testid="test-label">{testOrderLabel(test, language)}</strong>
                    {!test.catalogueItemId && (
                      <Chip className="ml-2 bg-muted text-muted-foreground">
                        {t('orders.kind.other')}
                      </Chip>
                    )}
                    {test.orderedAt && (
                      <Chip className="ml-2 bg-info-soft text-info">
                        <Lock aria-hidden className="mr-1 size-3" />
                        {t('orders.locked')}
                      </Chip>
                    )}
                  </p>
                  {!locked && (
                    <Button
                      type="button"
                      variant="link"
                      className="h-auto shrink-0 px-0 py-1 text-destructive"
                      aria-label={t('orders.remove', { name: test.name })}
                      onClick={() => onChange(tests.filter((x) => x.id !== test.id))}
                    >
                      {t('consult.remove')}
                    </Button>
                  )}
                </div>
                {!locked && (
                  <div className={grid}>
                    {item && (item.regions.length > 0 || test.region) && (
                      <div className={cell}>
                        <Label htmlFor={id('region')} className={fieldLabel}>
                          {t('orders.region')}
                        </Label>
                        <NativeSelect
                          id={id('region')}
                          value={test.region ?? ''}
                          onChange={(e) => set(test.id, { region: e.target.value })}
                        >
                          {/* The clinic may have dropped the stored region since: still shown
                              as chosen, so the screen matches what is saved. */}
                          {test.region && !item.regions.includes(test.region) && (
                            <option value={test.region}>
                              {t('orders.noLongerListed', { value: test.region })}
                            </option>
                          )}
                          {item.regions.map((r) => (
                            <option key={r} value={r}>
                              {r}
                            </option>
                          ))}
                        </NativeSelect>
                      </div>
                    )}
                    {imaging(test.kind) && (
                      <SideSelect
                        id={id('side')}
                        value={test.side}
                        onChange={(side) => set(test.id, { side })}
                      />
                    )}
                    {item && (item.views.length > 0 || test.views.length > 0) && (
                      <Views
                        name={id('views')}
                        // Views the clinic has dropped since stay, ticked, until unticked.
                        options={[
                          ...item.views,
                          ...test.views.filter((v) => !item.views.includes(v)),
                        ]}
                        unlisted={test.views.filter((v) => !item.views.includes(v))}
                        value={test.views}
                        onChange={(views) => set(test.id, { views })}
                      />
                    )}
                    <div className={cn(cell, 'col-span-full')}>
                      <Label htmlFor={id('notes')} className={fieldLabel}>
                        {t('orders.notes')}
                      </Label>
                      <Input
                        id={id('notes')}
                        value={test.notes ?? ''}
                        maxLength={500}
                        onChange={(e) => set(test.id, { notes: e.target.value || null })}
                      />
                    </div>
                  </div>
                )}
                {locked && test.notes && (
                  <p className="m-0 text-sm text-muted-foreground">{test.notes}</p>
                )}
              </li>
            );
          })}
        </ol>
      )}

      {editable && picking && (
        <PickImaging
          picking={picking}
          language={language}
          onChange={setPicking}
          onCancel={() => setPicking(null)}
          onAdd={(p) =>
            add({
              catalogueItemId: p.item.id,
              kind: p.item.kind,
              name: p.item.name,
              region: p.region,
              side: p.side,
              views: p.views,
              notes: null,
            })
          }
        />
      )}

      {editable && catalogueFailed && (
        <p
          role="alert"
          className="flex flex-wrap items-center gap-x-2 rounded-xl bg-danger-soft px-4 py-3 text-sm font-medium text-destructive"
        >
          {t('orders.catalogueFailed')}
          <Button
            type="button"
            variant="link"
            className="px-1"
            onClick={() => setAttempt((n) => n + 1)}
          >
            {t('common.retry')}
          </Button>
        </p>
      )}

      {editable && (
        <div className="space-y-2">
          <Label htmlFor="tests-search" className={fieldLabel}>
            {t('orders.search')}
          </Label>
          <div className="relative">
            <Search
              aria-hidden
              className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              id="tests-search"
              value={query}
              autoComplete="off"
              className="pl-10"
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          {q && (
            <ul
              className="max-h-72 space-y-0.5 overflow-y-auto rounded-xl border border-border bg-card p-1 shadow-soft"
              aria-label={t('orders.search')}
              data-testid="tests-matches"
            >
              {matches.map((m) => (
                <li key={m.id}>
                  <Button
                    type="button"
                    variant="ghost"
                    className={optionLook}
                    onClick={() => choose(m)}
                  >
                    <span>
                      <strong>{m.name}</strong>
                      {/* "Blood test" or "Other"; imaging is named by its kind already. */}
                      {!IMAGING_KINDS.includes(m.kind) && (
                        <span className="text-muted-foreground">
                          {' '}
                          · {t(`orders.kind.${m.kind}`)}
                        </span>
                      )}
                    </span>
                  </Button>
                </li>
              ))}
              {catalogue && matches.length === 0 && (
                <li className="px-3 py-2.5 text-sm text-muted-foreground">
                  {t('orders.noMatches')}
                </li>
              )}
              <li>
                <Button
                  type="button"
                  variant="ghost"
                  className={cn(optionLook, 'text-muted-foreground')}
                  onClick={() =>
                    add({
                      catalogueItemId: null,
                      kind: 'other',
                      name: query.trim().slice(0, 200),
                      region: null,
                      side: 'na',
                      views: [],
                      notes: null,
                    })
                  }
                >
                  <span>{t('orders.addFreeText', { text: query.trim() })}</span>
                </Button>
              </li>
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

/** Region, side and views for an imaging test before it joins the list. */
function PickImaging({
  picking,
  language,
  onChange,
  onCancel,
  onAdd,
}: {
  picking: Picking;
  language: Language;
  onChange(p: Picking): void;
  onCancel(): void;
  onAdd(p: Picking): void;
}) {
  const { t } = useSession();
  const { item } = picking;
  return (
    <div
      className="space-y-3 rounded-xl border border-primary/40 bg-accent/40 p-3"
      data-testid="test-picker"
    >
      <p className="m-0 font-semibold">{item.name}</p>
      <div className={grid}>
        <div className={cell}>
          <Label htmlFor="pick-region" className={fieldLabel}>
            {t('orders.region')}
          </Label>
          <NativeSelect
            id="pick-region"
            value={picking.region}
            onChange={(e) => onChange({ ...picking, region: e.target.value })}
          >
            <option value="">{t('orders.chooseRegion')}</option>
            {item.regions.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </NativeSelect>
        </div>
        <SideSelect
          id="pick-side"
          value={picking.side}
          onChange={(side) => onChange({ ...picking, side })}
        />
        {item.views.length > 0 && (
          <Views
            name="pick-views"
            options={item.views}
            value={picking.views}
            onChange={(views) => onChange({ ...picking, views })}
          />
        )}
      </div>
      {picking.region && (
        <p className="m-0 text-sm text-muted-foreground">
          {t('orders.printed', {
            label: testOrderLabel(
              { name: item.name, region: picking.region, side: picking.side, views: picking.views },
              language,
            ),
          })}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={!picking.region} onClick={() => onAdd(picking)}>
          {t('orders.add')}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
      </div>
    </div>
  );
}

function SideSelect({
  id,
  value,
  onChange,
}: {
  id: string;
  value: TestSide;
  onChange(side: TestSide): void;
}) {
  const { t } = useSession();
  return (
    <div className={cell}>
      <Label htmlFor={id} className={fieldLabel}>
        {t('orders.side')}
      </Label>
      <NativeSelect id={id} value={value} onChange={(e) => onChange(e.target.value as TestSide)}>
        {SIDES.map((s) => (
          <option key={s} value={s}>
            {t(`orders.side.${s}`)}
          </option>
        ))}
      </NativeSelect>
    </div>
  );
}

function Views({
  name,
  options,
  unlisted = [],
  value,
  onChange,
}: {
  name: string;
  options: string[];
  /** Stored views no longer in the catalogue's list, labelled as such. */
  unlisted?: string[];
  value: string[];
  onChange(views: string[]): void;
}) {
  const { t } = useSession();
  return (
    <fieldset className={cn(cell, 'col-span-full m-0 border-0 p-0')}>
      <legend className={cn(fieldLabel, 'mb-1.5')}>{t('orders.views')}</legend>
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        {options.map((v) => (
          <label key={v} className="inline-flex min-h-8 items-center gap-2 text-sm">
            <input
              type="checkbox"
              name={name}
              className="size-4 accent-primary"
              checked={value.includes(v)}
              onChange={(e) =>
                // Kept in the catalogue's order, so the printed list reads the same way.
                onChange(options.filter((o) => (o === v ? e.target.checked : value.includes(o))))
              }
            />
            {unlisted.includes(v) ? t('orders.noLongerListed', { value: v }) : v}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

const fieldLabel = 'block text-sm font-semibold';
const grid = 'grid grid-cols-2 items-end gap-2 sm:grid-cols-3';
const cell = 'min-w-0 space-y-1.5';
const optionLook = 'h-auto w-full justify-start whitespace-normal py-2.5 text-left font-normal';
