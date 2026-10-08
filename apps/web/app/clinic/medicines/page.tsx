'use client';

import { ApiError } from '@dhc/api-client';
import {
  MasterMedicine,
  MasterMedicineList,
  MedicineDecisionRow,
  MedicineQueue,
  NoContent,
  type SaveMedicineBody,
} from '@dhc/contracts';
import {
  Button,
  Chip,
  Field,
  Input,
  NativeSelect,
  PageHeader,
  Surface,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@dhc/ui-web';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useSession } from '../session-provider';
import { ClinicShell, NotAllowed } from '../shell';
import { MedicineForm } from './medicine-form';

const H2 = 'font-display text-lg font-bold';
const ROW = 'flex flex-wrap items-center gap-x-3 gap-y-2 py-3';
const MUTED = 'text-sm text-muted-foreground';

type Pending = MedicineQueue['pending'][number];

/** Clinic admin: the medicine list and the names doctors typed that are not on it (PRD §9.2). */
export default function MedicinesPage() {
  return (
    <ClinicShell>
      {(me) => (me.role === 'clinic_admin' ? <MedicinesScreen /> : <NotAllowed />)}
    </ClinicShell>
  );
}

/** Shared busy, error and notice handling for one tab. */
function useAction() {
  const { signOut, t } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const fail = useCallback(
    (e: unknown) => {
      if (e instanceof ApiError && e.status === 401) return void signOut('expired');
      setError(e instanceof ApiError ? e.message : t('error.network'));
    },
    [signOut, t],
  );

  /** Runs an action; resolves true when it succeeded. */
  async function run(action: () => Promise<string | null>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setNotice(await action());
      return true;
    } catch (e) {
      fail(e);
      return false;
    } finally {
      setBusy(false);
    }
  }

  const feedback = (
    <>
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
    </>
  );
  return { busy, run, fail, feedback };
}

function MedicinesScreen() {
  const { t } = useSession();
  return (
    <section className="space-y-5">
      <PageHeader title={t('medicines.title')} sub={t('medicines.sub')} />
      <Tabs defaultValue="queue">
        <TabsList>
          <TabsTrigger value="queue">{t('medicines.tabQueue')}</TabsTrigger>
          <TabsTrigger value="list">{t('medicines.tabList')}</TabsTrigger>
        </TabsList>
        <TabsContent value="queue">
          <QueueTab />
        </TabsContent>
        <TabsContent value="list">
          <ListTab />
        </TabsContent>
      </Tabs>
    </section>
  );
}

// ---- Approval queue ----------------------------------------------------------------------

function QueueTab() {
  const { api, locale, t } = useSession();
  const { busy, run, fail, feedback } = useAction();
  const [queue, setQueue] = useState<MedicineQueue | null>(null);
  const [open, setOpen] = useState<{ key: string; mode: 'new' | 'map' | 'reject' } | null>(null);

  const latest = useRef(0);
  const load = useCallback(async () => {
    const request = ++latest.current;
    const next = await api.request('GET', '/medicine-requests', { schema: MedicineQueue });
    if (request === latest.current) setQueue(next);
  }, [api]);

  useEffect(() => {
    load().catch(fail);
  }, [load, fail]);

  const date = (iso: string | null) =>
    iso
      ? new Intl.DateTimeFormat(locale === 'hi' ? 'hi-IN' : 'en-IN', {
          timeZone: 'Asia/Kolkata',
          day: 'numeric',
          month: 'short',
        }).format(new Date(iso))
      : '';

  const decide = (
    path: 'approve' | 'reject',
    body: object,
    notice: (row: MedicineDecisionRow) => string,
  ) =>
    run(async () => {
      const row = await api.request('POST', `/medicine-requests/${path}`, {
        schema: MedicineDecisionRow,
        body,
      });
      setOpen(null);
      await load();
      return notice(row);
    });

  const approved = (row: MedicineDecisionRow) =>
    t('medicines.approvedNotice', { name: row.name, medicine: row.medicine?.name ?? '' });

  const undo = (row: MedicineDecisionRow) =>
    run(async () => {
      await api.request('DELETE', `/medicine-requests/${row.id}`, { schema: NoContent });
      await load();
      return t('medicines.undone', { name: row.name });
    });

  const usage = (u: Pending) =>
    t('medicines.usage', { prescriptions: u.prescriptions, doctors: u.doctors });

  return (
    <div className="space-y-5">
      <Surface className="p-4 sm:p-6">
        <h2 className={H2}>{t('medicines.queueTitle')}</h2>
        <p className={`mt-1 ${MUTED}`}>{t('medicines.queueHint')}</p>
        {queue && queue.pending.length === 0 && <p className="mt-4">{t('medicines.queueEmpty')}</p>}
        {queue && queue.pending.length > 0 && (
          <ul className="mt-3 divide-y divide-border/70">
            {queue.pending.map((p) => (
              <li key={p.nameKey} data-testid={`pending-${p.nameKey}`} className={ROW}>
                <span className="min-w-0">
                  <strong>{p.name}</strong>
                  <span className={`block ${MUTED}`}>
                    {usage(p)}
                    {p.lastUsedAt && ` · ${t('medicines.lastUsed', { date: date(p.lastUsedAt) })}`}
                  </span>
                </span>
                <span className="ml-auto flex flex-wrap gap-2">
                  {(['new', 'map', 'reject'] as const).map((mode) => (
                    <Button
                      key={mode}
                      type="button"
                      variant="outline"
                      disabled={busy}
                      aria-expanded={open?.key === p.nameKey && open.mode === mode}
                      onClick={() =>
                        setOpen(
                          open?.key === p.nameKey && open.mode === mode
                            ? null
                            : { key: p.nameKey, mode },
                        )
                      }
                    >
                      {t(
                        mode === 'new'
                          ? 'medicines.addNew'
                          : mode === 'map'
                            ? 'medicines.mapExisting'
                            : 'medicines.reject',
                      )}
                    </Button>
                  ))}
                </span>
                {open?.key === p.nameKey && (
                  <div className="w-full">
                    {open.mode === 'new' && (
                      <MedicineForm
                        title={t('medicines.formTitleNew')}
                        initial={{ name: p.name }}
                        submitLabel={t('medicines.addNew')}
                        busy={busy}
                        onCancel={() => setOpen(null)}
                        onSubmit={(medicine) =>
                          void decide('approve', { name: p.name, medicine }, approved)
                        }
                      />
                    )}
                    {open.mode === 'map' && (
                      <MedicinePicker
                        name={p.name}
                        busy={busy}
                        onCancel={() => setOpen(null)}
                        onPick={(m) =>
                          void decide('approve', { name: p.name, medicineId: m.id }, approved)
                        }
                      />
                    )}
                    {open.mode === 'reject' && (
                      <form
                        className="flex flex-wrap items-end gap-3"
                        onSubmit={(e) => {
                          e.preventDefault();
                          const reason = String(new FormData(e.currentTarget).get('reason') ?? '');
                          void decide('reject', { name: p.name, reason }, (row) =>
                            t('medicines.rejectedNotice', { name: row.name }),
                          );
                        }}
                      >
                        <div className="w-full sm:w-96">
                          <Field
                            label={t('medicines.rejectReason', { name: p.name })}
                            hint={t('medicines.rejectHint')}
                          >
                            <Input name="reason" required maxLength={300} />
                          </Field>
                        </div>
                        <Button type="submit" disabled={busy}>
                          {t('medicines.confirmReject')}
                        </Button>
                        <Button type="button" variant="outline" onClick={() => setOpen(null)}>
                          {t('common.cancel')}
                        </Button>
                      </form>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Surface>

      {feedback}

      <Surface className="p-4 sm:p-6">
        <h2 className={H2}>{t('medicines.decidedTitle')}</h2>
        {queue && queue.decided.length === 0 && (
          <p className={`mt-2 ${MUTED}`}>{t('medicines.decidedEmpty')}</p>
        )}
        {queue && queue.decided.length > 0 && (
          <ul className="mt-3 divide-y divide-border/70">
            {queue.decided.map((row) => (
              <li key={row.id} data-testid={`decided-${row.nameKey}`} className={ROW}>
                <span className="min-w-0">
                  <strong>{row.name}</strong>{' '}
                  {row.decision === 'approved' ? (
                    <Chip className="bg-success-soft text-success">
                      {t('medicines.approved', { name: row.medicine?.name ?? '' })}
                    </Chip>
                  ) : (
                    <Chip className="bg-danger-soft text-destructive">
                      {t('medicines.rejected')}
                    </Chip>
                  )}
                  <span className={`block ${MUTED}`}>
                    {row.reason && `${row.reason} · `}
                    {usage(row)} ·{' '}
                    {t('medicines.decidedBy', {
                      name: row.decidedByName ?? '—',
                      date: date(row.decidedAt),
                    })}
                  </span>
                </span>
                <Button
                  type="button"
                  variant="outline"
                  className="ml-auto"
                  disabled={busy}
                  onClick={() => void undo(row)}
                >
                  {t('medicines.undo')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Surface>
    </div>
  );
}

/** Search the active medicine list to link a typed name to a medicine already on it. */
function MedicinePicker({
  name,
  busy,
  onPick,
  onCancel,
}: {
  name: string;
  busy: boolean;
  onPick: (medicine: MasterMedicine) => void;
  onCancel: () => void;
}) {
  const { api, t } = useSession();
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<MasterMedicine[] | null>(null);
  const q = query.trim();

  useEffect(() => {
    if (q.length < 2) return void setMatches(null);
    let current = true;
    const timer = setTimeout(() => {
      api
        .request('GET', '/medicine-master', { schema: MasterMedicineList, query: { q } })
        .then((list) => current && setMatches(list.data))
        .catch(() => current && setMatches([]));
    }, 250);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [api, q]);

  return (
    <div className="space-y-3 rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-full sm:w-80">
          <Field
            label={t('medicines.pickMedicine', { name })}
            hint={t('medicines.findMoleculeHint')}
          >
            <Input type="search" value={query} onChange={(e) => setQuery(e.target.value)} />
          </Field>
        </div>
        <Button type="button" variant="outline" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
      </div>
      {matches && matches.length === 0 && <p className={MUTED}>{t('medicines.none')}</p>}
      {matches && matches.length > 0 && (
        <ul className="space-y-1" aria-live="polite">
          {matches.map((m) => (
            <li key={m.id}>
              <Button
                type="button"
                variant="ghost"
                className="h-auto w-full justify-start whitespace-normal py-2 text-left"
                disabled={busy}
                onClick={() => onPick(m)}
              >
                <span>
                  {t('medicines.mapTo', { name: m.name })}{' '}
                  <span className="text-muted-foreground">{m.composition}</span>
                </span>
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---- Medicine list -----------------------------------------------------------------------

function ListTab() {
  const { api, t } = useSession();
  const { busy, run, fail, feedback } = useAction();
  const [query, setQuery] = useState('');
  const [source, setSource] = useState<'' | 'reference' | 'clinic'>('');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [list, setList] = useState<MasterMedicineList | null>(null);
  const [editing, setEditing] = useState<MasterMedicine | 'new' | null>(null);
  const q = query.trim();

  const latest = useRef(0);
  const load = useCallback(async () => {
    const request = ++latest.current;
    const next = await api.request('GET', '/medicine-master', {
      schema: MasterMedicineList,
      query: {
        q: q || undefined,
        source: source || undefined,
        includeInactive: includeInactive ? 'true' : undefined,
      },
    });
    if (request === latest.current) setList(next);
  }, [api, q, source, includeInactive]);

  useEffect(() => {
    const timer = setTimeout(() => load().catch(fail), 250);
    return () => clearTimeout(timer);
  }, [load, fail]);

  const bodyOf = (m: MasterMedicine): SaveMedicineBody => ({
    name: m.name,
    genericName: m.genericName,
    composition: m.composition,
    form: m.form,
    defaultRoute: m.defaultRoute,
    ingredients: m.ingredients.map(({ moleculeId, strengthMg, per }) => ({
      moleculeId,
      strengthMg,
      per,
    })),
  });

  const save = (body: SaveMedicineBody) =>
    run(async () => {
      const saved =
        editing === 'new' || editing === null
          ? await api.request('POST', '/medicine-master', { schema: MasterMedicine, body })
          : await api.request('PUT', `/medicine-master/${editing.id}`, {
              schema: MasterMedicine,
              body: { ...body, active: editing.active },
            });
      setEditing(null);
      await load();
      return t('medicines.saved', { name: saved.name });
    });

  const setActive = (m: MasterMedicine, active: boolean) =>
    run(async () => {
      await api.request('PUT', `/medicine-master/${m.id}`, {
        schema: MasterMedicine,
        body: { ...bodyOf(m), active },
      });
      await load();
      return null;
    });

  return (
    <Surface className="space-y-4 p-4 sm:p-6">
      <form
        role="search"
        className="grid items-end gap-3 sm:grid-cols-[1fr_14rem_auto]"
        onSubmit={(e: FormEvent) => e.preventDefault()}
      >
        <Field label={t('medicines.search')}>
          <Input type="search" value={query} onChange={(e) => setQuery(e.target.value)} />
        </Field>
        <Field label={t('medicines.source')}>
          <NativeSelect value={source} onChange={(e) => setSource(e.target.value as typeof source)}>
            <option value="">{t('medicines.sourceAll')}</option>
            <option value="reference">{t('medicines.sourceReference')}</option>
            <option value="clinic">{t('medicines.sourceClinic')}</option>
          </NativeSelect>
        </Field>
        <label className="flex h-11 items-center gap-2 text-sm font-medium">
          <input
            type="checkbox"
            className="size-4"
            checked={includeInactive}
            onChange={(e) => setIncludeInactive(e.target.checked)}
          />
          {t('medicines.includeInactive')}
        </label>
      </form>

      {editing === null ? (
        <Button type="button" disabled={busy} onClick={() => setEditing('new')}>
          {t('medicines.add')}
        </Button>
      ) : (
        <MedicineForm
          key={editing === 'new' ? 'new' : editing.id}
          title={
            editing === 'new'
              ? t('medicines.formTitleNew')
              : t('medicines.formTitleEdit', { name: editing.name })
          }
          initial={editing === 'new' ? undefined : editing}
          submitLabel={t('common.save')}
          busy={busy}
          onCancel={() => setEditing(null)}
          onSubmit={(body) => void save(body)}
        />
      )}

      {feedback}

      {list && list.data.length === 0 && <p className={MUTED}>{t('medicines.none')}</p>}
      {list && list.data.length > 0 && (
        <ul className="divide-y divide-border/70">
          {list.data.map((m) => (
            <li key={m.id} data-testid={`medicine-${m.name}`} className={ROW}>
              <span className="min-w-0">
                <strong>{m.name}</strong>{' '}
                <span className={MUTED}>
                  {m.composition} · {m.form}
                </span>
                <span className="mt-1 flex flex-wrap gap-1.5">
                  <Chip>
                    {m.source === 'reference'
                      ? t('medicines.sourceReference')
                      : t('medicines.sourceClinic')}
                  </Chip>
                  {!m.active && <Chip>{t('practice.inactive')}</Chip>}
                  {m.ingredients.length === 0 && (
                    <Chip className="bg-warning-soft text-warning-foreground">
                      {t('medicines.noIngredients')}
                    </Chip>
                  )}
                </span>
              </span>
              {m.source === 'clinic' && (
                <span className="ml-auto flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy}
                    onClick={() => setEditing(m)}
                  >
                    {t('medicines.edit')}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void setActive(m, !m.active)}
                  >
                    {m.active ? t('practice.deactivate') : t('practice.activate')}
                  </Button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {list?.hasMore && <p className={MUTED}>{t('medicines.hasMore')}</p>}
    </Surface>
  );
}
