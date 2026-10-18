'use client';

import { ApiError } from '@dhc/api-client';
import {
  IMAGING_KINDS,
  MAX_CATALOGUE_REGIONS,
  TestKind,
  XRAY_VIEWS,
  XrayView,
  type AdminTestCatalogueItem,
} from '@dhc/contracts';
import {
  Button,
  Chip,
  EmptyState,
  Field,
  Input,
  NativeSelect,
  PageHeader,
  Surface,
  Textarea,
} from '@dhc/ui-web';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useSession } from '../session-provider';
import { ClinicShell, NotAllowed } from '../shell';

const H2 = 'font-display text-lg font-bold';
const ROW = 'flex flex-wrap items-center gap-x-3 gap-y-2 py-3';
const MUTED = 'text-sm text-muted-foreground';

const KINDS = TestKind.options;

/** Clinic admin: the tests doctors order from, by type (PRD §7.1, §9.2). */
export default function TestCataloguePage() {
  return (
    <ClinicShell>
      {(me) => (me.role === 'clinic_admin' ? <CatalogueScreen /> : <NotAllowed />)}
    </ClinicShell>
  );
}

/** What the form edits; regions are typed one per line. */
interface Draft {
  kind: TestKind;
  name: string;
  regions: string;
  views: XrayView[];
}

const linesOf = (text: string) =>
  text
    .split('\n')
    .map((r) => r.trim())
    .filter(Boolean);

function CatalogueScreen() {
  const { api, signOut, t } = useSession();
  const [items, setItems] = useState<AdminTestCatalogueItem[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [editing, setEditing] = useState<AdminTestCatalogueItem | 'new' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Only the latest request may set the list, so a slow first load cannot hide an edit.
  const latest = useRef(0);
  const load = useCallback(async () => {
    const request = ++latest.current;
    const list = await api.testCatalogueItems();
    if (request === latest.current) {
      setItems(list.data);
      setLoadFailed(false);
    }
  }, [api]);

  const fail = useCallback(
    (e: unknown) => {
      if (e instanceof ApiError && e.status === 401) return void signOut('expired');
      setError(e instanceof ApiError ? e.message : t('error.network'));
    },
    [signOut, t],
  );

  const loadOrFail = useCallback(
    () =>
      load().catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 401) return void signOut('expired');
        setLoadFailed(true);
      }),
    [load, signOut],
  );

  useEffect(() => {
    void loadOrFail();
  }, [loadOrFail]);

  const retry = () => {
    setLoadFailed(false);
    void loadOrFail();
  };

  /** Runs a change; a list that is out of date is reloaded and said so. */
  async function run(action: () => Promise<string | null>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setNotice(await action());
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.fields.ids === 'stale') {
        await load().catch(() => undefined);
        setError(t('catalogue.stale'));
      } else {
        fail(e);
      }
      return false;
    } finally {
      setBusy(false);
    }
  }

  // One key per add form: a retried submit (a lost response) adds the test once.
  const [addKey, setAddKey] = useState(() => crypto.randomUUID());

  const save = (draft: Draft) =>
    run(async () => {
      const regions = IMAGING_KINDS.includes(draft.kind) ? linesOf(draft.regions) : [];
      const views = draft.kind === 'xray' ? draft.views : [];
      if (editing === 'new' || editing === null) {
        const item = await api
          .createTestCatalogueItem({ kind: draft.kind, name: draft.name, regions, views }, addKey)
          .catch((e: unknown) => {
            // The server answered, so nothing was added: a corrected form is a new attempt.
            // Only a lost answer keeps the key for the retry.
            if (e instanceof ApiError) setAddKey(crypto.randomUUID());
            throw e;
          });
        setAddKey(crypto.randomUUID());
        setEditing(null);
        await load();
        return t('catalogue.added', { name: item.name });
      }
      const item = await api.updateTestCatalogueItem(editing.id, {
        name: draft.name,
        ...(IMAGING_KINDS.includes(editing.kind) ? { regions } : {}),
        ...(editing.kind === 'xray' ? { views } : {}),
      });
      setEditing(null);
      await load();
      return t('catalogue.saved', { name: item.name });
    });

  const setActive = (item: AdminTestCatalogueItem, active: boolean) =>
    run(async () => {
      const saved = await api.updateTestCatalogueItem(item.id, { active });
      await load();
      return t(active ? 'catalogue.activated' : 'catalogue.deactivated', { name: saved.name });
    });

  const move = (group: AdminTestCatalogueItem[], index: number, by: -1 | 1) =>
    run(async () => {
      const ids = group.map((i) => i.id);
      const [moved] = ids.splice(index, 1);
      ids.splice(index + by, 0, moved!);
      const list = await api.reorderTestCatalogue({ kind: group[0]!.kind, ids });
      setItems(list.data);
      return null;
    });

  return (
    <section className="space-y-5">
      <PageHeader
        title={t('catalogue.title')}
        sub={t('catalogue.sub')}
        actions={
          editing === null && items ? (
            <Button type="button" disabled={busy} onClick={() => setEditing('new')}>
              {t('catalogue.add')}
            </Button>
          ) : undefined
        }
      />

      {editing !== null && (
        <CatalogueForm
          key={editing === 'new' ? 'new' : editing.id}
          item={editing === 'new' ? null : editing}
          busy={busy}
          onCancel={() => setEditing(null)}
          onSubmit={(draft) => void save(draft)}
        />
      )}

      {notice && (
        <p role="status" className="rounded-xl bg-success-soft px-4 py-3 text-sm text-success">
          {notice}
        </p>
      )}
      {error && (
        <p
          role="alert"
          className="rounded-xl bg-danger-soft px-4 py-3 text-sm font-medium text-destructive"
        >
          {error}
        </p>
      )}

      {!items && !loadFailed && (
        <p aria-live="polite" className={MUTED}>
          {t('common.loading')}
        </p>
      )}
      {!items && loadFailed && (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-xl bg-muted p-4">
          <span className="text-sm">{t('catalogue.loadFailed')}</span>
          <Button type="button" variant="outline" onClick={retry}>
            {t('common.retry')}
          </Button>
        </div>
      )}

      {items &&
        KINDS.map((kind) => {
          const group = items.filter((i) => i.kind === kind);
          return (
            <Surface
              key={kind}
              className="p-4 sm:p-6"
              data-testid={`catalogue-${kind}`}
              aria-labelledby={`catalogue-${kind}-title`}
            >
              <h2 id={`catalogue-${kind}-title`} className={H2}>
                {t(`orders.kind.${kind}`)}
              </h2>
              {group.length === 0 ? (
                <div className="mt-3">
                  <EmptyState title={t('catalogue.empty')} />
                </div>
              ) : (
                <ul className="mt-3 divide-y divide-border/70">
                  {group.map((item, index) => (
                    <li key={item.id} data-testid={`catalogue-item-${item.name}`} className={ROW}>
                      <span className="min-w-0">
                        <strong className={item.active ? undefined : 'text-muted-foreground'}>
                          {item.name}
                        </strong>
                        <span className="mt-1 flex flex-wrap gap-1.5">
                          {!item.active && <Chip>{t('practice.inactive')}</Chip>}
                          {item.regions.length > 0 && (
                            <Chip>
                              {t('catalogue.regionCount', { count: item.regions.length })}
                            </Chip>
                          )}
                          {item.views.length > 0 && (
                            <Chip>{t('catalogue.viewList', { views: item.views.join(', ') })}</Chip>
                          )}
                        </span>
                      </span>
                      <span className="ml-auto flex flex-wrap gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          disabled={busy || index === 0}
                          aria-label={t('catalogue.moveUp', { name: item.name })}
                          onClick={() => void move(group, index, -1)}
                        >
                          <ArrowUp aria-hidden className="size-4" />
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          disabled={busy || index === group.length - 1}
                          aria-label={t('catalogue.moveDown', { name: item.name })}
                          onClick={() => void move(group, index, 1)}
                        >
                          <ArrowDown aria-hidden className="size-4" />
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          disabled={busy}
                          onClick={() => setEditing(item)}
                        >
                          {t('catalogue.edit')}
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          disabled={busy}
                          onClick={() => void setActive(item, !item.active)}
                        >
                          {item.active ? t('practice.deactivate') : t('practice.activate')}
                        </Button>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Surface>
          );
        })}
    </section>
  );
}

/** Add a test, or edit one's name, regions and views (its type stays). */
function CatalogueForm({
  item,
  busy,
  onSubmit,
  onCancel,
}: {
  item: AdminTestCatalogueItem | null;
  busy: boolean;
  onSubmit: (draft: Draft) => void;
  onCancel: () => void;
}) {
  const { t } = useSession();
  const [draft, setDraft] = useState<Draft>(() => ({
    kind: item?.kind ?? 'blood',
    name: item?.name ?? '',
    regions: item?.regions.join('\n') ?? '',
    views: (item?.views ?? []).filter((v) => XrayView.safeParse(v).success) as XrayView[],
  }));
  const imaging = IMAGING_KINDS.includes(draft.kind);

  function submit(event: FormEvent) {
    event.preventDefault();
    onSubmit(draft);
  }

  return (
    <Surface className="p-4 sm:p-6">
      <form
        data-testid="catalogue-form"
        aria-labelledby="catalogue-form-title"
        className="space-y-4"
        onSubmit={submit}
      >
        <h2 id="catalogue-form-title" className={H2}>
          {item ? t('catalogue.editTitle', { name: item.name }) : t('catalogue.addTitle')}
        </h2>
        <div className="grid gap-4 sm:grid-cols-[14rem_1fr]">
          <Field label={t('catalogue.kind')} hint={item ? t('catalogue.kindFixed') : undefined}>
            <NativeSelect
              value={draft.kind}
              disabled={item !== null}
              onChange={(e) => setDraft({ ...draft, kind: e.target.value as TestKind })}
            >
              {KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {t(`orders.kind.${kind}`)}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label={t('catalogue.name')} hint={t('catalogue.nameHint')}>
            <Input
              value={draft.name}
              required
              maxLength={120}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </Field>
        </div>
        {imaging && (
          <Field
            label={t('catalogue.regions')}
            hint={t('catalogue.regionsHint', { max: MAX_CATALOGUE_REGIONS })}
          >
            <Textarea
              rows={6}
              value={draft.regions}
              onChange={(e) => setDraft({ ...draft, regions: e.target.value })}
            />
          </Field>
        )}
        {draft.kind === 'xray' && (
          <fieldset>
            <legend className="text-sm font-medium">{t('catalogue.views')}</legend>
            <div className="mt-2 flex flex-wrap gap-4">
              {XRAY_VIEWS.map((view) => (
                <label key={view} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="size-4"
                    checked={draft.views.includes(view)}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        // Kept in the standard order, whatever order they were ticked in.
                        views: XRAY_VIEWS.filter((v) =>
                          v === view ? e.target.checked : draft.views.includes(v),
                        ),
                      })
                    }
                  />
                  {view}
                </label>
              ))}
            </div>
          </fieldset>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={busy}>
            {item ? t('common.save') : t('catalogue.add')}
          </Button>
          <Button type="button" variant="outline" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
        </div>
      </form>
    </Surface>
  );
}
