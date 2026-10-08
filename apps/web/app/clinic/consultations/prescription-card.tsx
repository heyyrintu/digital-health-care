'use client';

import { ApiError } from '@dhc/api-client';
import {
  LastPrescription,
  MedicineList,
  Prescription,
  PrescriptionTemplate,
  PrescriptionTemplateList,
  PrescriptionView,
  SafetySummary,
  type Language,
  type Medicine,
  type PrescriptionItem,
  type TemplateItem,
} from '@dhc/contracts';
import { Button, Input, Label, NativeSelect, cn } from '@dhc/ui-web';
import { Copy, Search } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useSession } from '../session-provider';
import { remarksOf, RxLine } from './rx-line';
import { LineAlerts, SafetyBanner, type SafetyAct } from './safety-alerts';
import { SignPanel } from './sign-panel';

const AUTOSAVE_MS = 1200;
/** The most lines a prescription can hold (the API limit). */
const MAX_LINES = 30;

type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'stale' | 'error';

/** A sensible first dose for the medicine's form; the doctor changes it as needed. */
function defaultDose(form: string | null): string {
  switch (form) {
    case 'tablet':
      return '1 tablet';
    case 'capsule':
      return '1 capsule';
    case 'syrup':
      return '5 ml';
    case 'gel':
    case 'cream':
    case 'ointment':
      return 'a thin layer';
    case 'sachet':
      return '1 sachet';
    case 'drops':
      return '1 drop';
    default:
      return '';
  }
}

function lineFromMedicine(m: Medicine): PrescriptionItem {
  const oral = m.defaultRoute === 'oral';
  return {
    id: crypto.randomUUID(),
    medicineId: m.id,
    name: m.name,
    composition: m.composition,
    form: m.form,
    route: m.defaultRoute,
    timing: oral ? 'after_food' : null,
    steps: [{ dose: defaultDose(m.form), frequency: '', durationValue: 5, durationUnit: 'days' }],
    quantity: null,
    instructions: null,
    remarks: '',
    remarksEdited: false,
  };
}

function freeTextLine(name: string): PrescriptionItem {
  return {
    id: crypto.randomUUID(),
    medicineId: null,
    name,
    composition: null,
    form: null,
    route: 'oral',
    timing: null,
    steps: [{ dose: '', frequency: '', durationValue: 5, durationUnit: 'days' }],
    quantity: null,
    instructions: null,
    remarks: '',
    remarksEdited: false,
  };
}

const withNewIds = (items: TemplateItem[]): PrescriptionItem[] =>
  items.map((i) => ({ ...i, id: crypto.randomUUID() }));

/**
 * The prescription builder on the consultation screen (PRD §6.4). Lines autosave like
 * the notes, and the server runs the safety engine (PRD §6.5) on every save; its alerts
 * show on each line. Signing, amendments and voiding are in the sign panel (PRD §6.6).
 */
export function PrescriptionCard({
  appointmentId,
  patientId,
  onSignedChange,
}: {
  appointmentId: string;
  patientId: string;
  /** Signing locks the visit record; the page reloads it. */
  onSignedChange?(): void;
}) {
  const { api, signOut, t } = useSession();
  const [view, setView] = useState<PrescriptionView | null>(null);
  const [items, setItems] = useState<PrescriptionItem[]>([]);
  const [language, setLanguage] = useState<Language>('en');
  const [state, setState] = useState<SaveState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<Medicine[] | null>(null);
  const [templates, setTemplates] = useState<PrescriptionTemplate[]>([]);
  const [templateId, setTemplateId] = useState('');
  const [safety, setSafety] = useState<SafetySummary | null>(null);

  const latest = useRef({ items, language });
  const revision = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const inFlight = useRef(false);
  const again = useRef(false);
  const edits = useRef(0);

  // Kept in refs so switching the clinic language never re-runs the load (which would
  // drop unsaved lines).
  const session = useRef({ signOut, t });
  useEffect(() => {
    session.current = { signOut, t };
  }, [signOut, t]);
  const fail = useCallback((e: unknown) => {
    if (e instanceof ApiError && e.status === 401) return void session.current.signOut('expired');
    setError(e instanceof ApiError ? e.message : session.current.t('error.network'));
  }, []);

  const load = useCallback(async () => {
    setError(null);
    try {
      const v = await api.request('GET', `/appointments/${appointmentId}/prescription`, {
        schema: PrescriptionView,
      });
      setView(v);
      const next = v.prescription?.items ?? [];
      const lang = v.prescription?.language ?? v.defaultLanguage;
      setItems(next);
      setLanguage(lang);
      latest.current = { items: next, language: lang };
      revision.current = v.prescription?.revision ?? 0;
      setSafety(v.prescription?.safety ?? null);
      setState(v.prescription ? 'saved' : 'idle');
    } catch (e) {
      fail(e);
    }
  }, [api, appointmentId, fail]);

  useEffect(() => {
    void load();
    api
      .request('GET', '/prescription-templates', { schema: PrescriptionTemplateList })
      .then((list) => setTemplates(list.data))
      .catch(() => setTemplates([]));
  }, [api, load]);

  // Medicine search, shortly after typing stops.
  // Results for an older query are dropped, and nothing stays clickable while typing.
  useEffect(() => {
    setMatches(null);
    const q = query.trim();
    if (q.length < 2) return;
    let current = true;
    const handle = setTimeout(() => {
      api
        .request('GET', '/medicines', { schema: MedicineList, query: { q } })
        .then((list) => current && setMatches(list.data))
        .catch((e) => current && fail(e));
    }, 250);
    return () => {
      current = false;
      clearTimeout(handle);
    };
  }, [api, query, fail]);

  const save = useCallback(async () => {
    if (inFlight.current) {
      again.current = true;
      return;
    }
    inFlight.current = true;
    setState('saving');
    const { items: lines, language: lang } = latest.current;
    const editsAtStart = edits.current;
    try {
      const saved = await api.request('PUT', `/appointments/${appointmentId}/prescription`, {
        schema: Prescription,
        body: { language: lang, items: lines, revision: revision.current },
      });
      revision.current = saved.revision;
      setSafety(saved.safety);
      setError(null);
      setState(edits.current === editsAtStart ? 'saved' : 'dirty');
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.fields.revision === 'stale') {
        // Edits queued meanwhile cannot save over the newer version; other failures
        // still retry them once.
        again.current = false;
        setState('stale');
      } else {
        setState('error');
        fail(e);
      }
    } finally {
      inFlight.current = false;
      if (again.current) {
        again.current = false;
        void save();
      }
    }
  }, [api, appointmentId, fail]);

  const edit = (next: PrescriptionItem[], lang = latest.current.language) => {
    setItems(next);
    setLanguage(lang);
    latest.current = { items: next, language: lang };
    edits.current += 1;
    setState('dirty');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = undefined;
      void save();
    }, AUTOSAVE_MS);
  };

  // Leaving the screen (e.g. back to the queue) saves lines still waiting for the timer.
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  }, [save]);
  useEffect(
    () => () => {
      if (timer.current === undefined) return;
      clearTimeout(timer.current);
      timer.current = undefined;
      void saveRef.current();
    },
    // Mounted once per visit (the page keys it by appointment), so this is the only flush.
    [],
  );

  // Warn before leaving with lines not yet saved (same as the notes).
  useEffect(() => {
    if (state !== 'dirty' && state !== 'saving') return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [state]);

  /** The doctor's answer to an alert; the server returns the updated check. */
  const act: SafetyAct = async (key, action, reason) => {
    const editsAtStart = edits.current;
    try {
      const summary = await api.request(
        'POST',
        `/appointments/${appointmentId}/prescription/safety-actions`,
        { schema: SafetySummary, body: { key, action, reason } },
      );
      // Lines edited meanwhile: their save brings a newer check, so keep that one.
      if (edits.current === editsAtStart) setSafety(summary);
      setError(null);
      return true;
    } catch (e) {
      // The alert no longer applies (the chart or lines changed): show the current check.
      if (e instanceof ApiError && e.status === 409 && edits.current === editsAtStart) {
        void load();
      } else {
        fail(e);
      }
      return false;
    }
  };

  /** Adds lines after the latest ones, within the limit the API accepts. */
  const append = (lines: PrescriptionItem[]) => {
    const current = latest.current.items;
    if (current.length + lines.length > MAX_LINES) {
      setNotice(t('rx.tooMany', { max: MAX_LINES }));
      return false;
    }
    edit([...current, ...lines]);
    return true;
  };

  const add = (line: PrescriptionItem) => {
    setNotice(null);
    if (!append([line])) return;
    setQuery('');
    setMatches(null);
  };

  async function repeatLast() {
    setNotice(null);
    try {
      const { last } = await api.request('GET', `/patients/${patientId}/last-prescription`, {
        schema: LastPrescription,
        query: { before: appointmentId },
      });
      if (!last) return setNotice(t('rx.noLast'));
      if (append(withNewIds(last.items))) {
        setNotice(t('rx.repeated', { count: last.items.length, date: last.date }));
      }
    } catch (e) {
      fail(e);
    }
  }

  function applyTemplate() {
    const template = templates.find((x) => x.id === templateId);
    setNotice(null);
    if (template) append(withNewIds(template.items));
  }

  async function deleteTemplate() {
    if (!templateId) return;
    try {
      await api.deletePrescriptionTemplate(templateId);
      setTemplates(templates.filter((x) => x.id !== templateId));
      setTemplateId('');
    } catch (e) {
      fail(e);
    }
  }

  async function saveTemplate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const name = String(new FormData(form).get('templateName') ?? '').trim();
    if (!name || items.length === 0 || state === 'stale') return;
    try {
      const saved = await api.request('POST', '/prescription-templates', {
        schema: PrescriptionTemplate,
        body: {
          name,
          items: items.map(({ id: _id, ...line }) => ({
            ...line,
            remarks: remarksOf({ id: _id, ...line }, language),
          })),
        },
      });
      setTemplates(
        [...templates.filter((x) => x.id !== saved.id), saved].sort((a, b) =>
          a.name.localeCompare(b.name),
        ),
      );
      setNotice(t('rx.templateSaved', { name: saved.name }));
      form.reset();
    } catch (e) {
      fail(e);
    }
  }

  if (!view) {
    return error ? (
      <p role="alert" className={alertBox}>
        {error}
      </p>
    ) : (
      <p aria-live="polite" className="text-sm text-muted-foreground">
        {t('common.loading')}
      </p>
    );
  }

  const editable = view.canEdit && state !== 'stale';
  // Alerts belong to the last saved lines: while changes wait to save, they may be out of date.
  // After a failed save they belong to lines no longer on screen, so they wait too.
  const checking = state === 'dirty' || state === 'saving' || state === 'error';
  const alertsFor = (itemId: string | null) =>
    safety?.alerts.filter((a) => a.itemId === itemId) ?? [];
  const status =
    state === 'saving'
      ? t('consult.saving')
      : state === 'dirty' || state === 'error'
        ? t('consult.unsaved')
        : state === 'saved'
          ? t('rx.saved')
          : '';

  const draft = (view.prescription?.status ?? 'draft') === 'draft';
  const blocked = checking
    ? t('sign.blocked.saving')
    : items.length === 0
      ? t('sign.blocked.empty')
      : safety && (safety.openBlocks > 0 || safety.openWarnings > 0)
        ? t('sign.blocked.safety')
        : null;
  const signPanel = (
    <SignPanel
      appointmentId={appointmentId}
      view={view}
      prescription={view.prescription}
      revision={revision.current}
      blocked={blocked}
      onChanged={() => {
        void load();
        onSignedChange?.();
      }}
      onError={fail}
    />
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <h2 className="font-display text-lg font-bold">{t('rx.title')}</h2>
        <p
          aria-live="polite"
          data-testid="rx-save-status"
          className={cn(
            'inline-flex min-h-6 items-center gap-1.5 whitespace-nowrap text-xs font-medium text-muted-foreground',
            state === 'error' && 'text-destructive',
          )}
        >
          {status && (
            <span
              aria-hidden
              className={cn(
                'size-2 rounded-full',
                state === 'saved'
                  ? 'bg-success'
                  : state === 'error'
                    ? 'bg-destructive'
                    : 'bg-warning',
              )}
            />
          )}
          {status}
        </p>
      </div>
      {!view.canEdit && draft && <p className={noticeBox}>{t('rx.readOnly')}</p>}
      {!draft && signPanel}
      {state === 'stale' && (
        <p role="alert" className={cn(alertBox, 'flex flex-wrap items-center gap-x-2')}>
          {t('rx.stale')}{' '}
          <Button type="button" variant="link" className="px-1" onClick={() => void load()}>
            {t('consult.reload')}
          </Button>
        </p>
      )}
      {error && state !== 'stale' && (
        <p role="alert" className={alertBox}>
          {error}
        </p>
      )}
      {notice && <p className={noticeBox}>{notice}</p>}
      {items.length > 0 && <SafetyBanner safety={safety} checking={checking} />}
      <LineAlerts alerts={alertsFor(null)} canAct={editable && !checking} onAct={act} />

      <fieldset className="m-0 min-w-0 space-y-4 border-0 p-0" disabled={!editable}>
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-40 space-y-1.5">
            <Label htmlFor="rx-language" className={fieldLabel}>
              {t('rx.language')}
            </Label>
            <NativeSelect
              id="rx-language"
              value={language}
              onChange={(e) => edit(items, e.target.value as Language)}
            >
              <option value="en">English</option>
              <option value="hi">हिन्दी</option>
            </NativeSelect>
          </div>
          <Button type="button" variant="outline" onClick={() => void repeatLast()}>
            <Copy aria-hidden />
            {t('rx.repeatLast')}
          </Button>
          {templates.length > 0 && (
            <div className="flex flex-wrap items-end gap-2">
              <div className="w-full space-y-1.5 sm:w-56">
                <Label htmlFor="rx-template" className={fieldLabel}>
                  {t('rx.templates')}
                </Label>
                <NativeSelect
                  id="rx-template"
                  value={templateId}
                  onChange={(e) => setTemplateId(e.target.value)}
                >
                  <option value="">{t('rx.chooseTemplate')}</option>
                  {templates.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <Button
                type="button"
                variant="outline"
                disabled={!templateId}
                onClick={applyTemplate}
              >
                {t('rx.applyTemplate')}
              </Button>
              <Button
                type="button"
                variant="link"
                className="text-destructive"
                disabled={!templateId}
                onClick={() => void deleteTemplate()}
              >
                {t('rx.deleteTemplate')}
              </Button>
            </div>
          )}
        </div>

        {items.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
            {t('rx.empty')}
          </p>
        ) : (
          <ol className="m-0 list-none space-y-3 p-0">
            {items.map((item, i) => (
              <RxLine
                key={item.id}
                item={item}
                index={i}
                language={language}
                editable={editable}
                onChange={(next) => edit(items.map((x) => (x.id === next.id ? next : x)))}
                onRemove={() => edit(items.filter((x) => x.id !== item.id))}
                alerts={
                  <LineAlerts
                    alerts={alertsFor(item.id)}
                    canAct={editable && !checking}
                    onAct={act}
                  />
                }
              />
            ))}
          </ol>
        )}

        <div className="space-y-2">
          <Label htmlFor="rx-search" className={fieldLabel}>
            {t('rx.search')}
          </Label>
          <div className="relative">
            <Search
              aria-hidden
              className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              id="rx-search"
              value={query}
              autoComplete="off"
              className="pl-10"
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          {query.trim().length >= 2 && (
            <ul
              className="max-h-80 space-y-0.5 overflow-y-auto rounded-xl border border-border bg-card p-1 shadow-soft"
              role="listbox"
              aria-label={t('rx.search')}
            >
              {matches?.map((m) => (
                <li key={m.id}>
                  <Button
                    type="button"
                    variant="ghost"
                    className={optionLook}
                    role="option"
                    aria-selected={false}
                    onClick={() => add(lineFromMedicine(m))}
                  >
                    <span>
                      <strong>{m.name}</strong>{' '}
                      <span className="text-muted-foreground">{m.composition}</span>
                    </span>
                  </Button>
                </li>
              ))}
              {matches?.length === 0 && (
                <li
                  role="option"
                  aria-selected={false}
                  aria-disabled
                  className="px-3 py-2.5 text-sm text-muted-foreground"
                >
                  {t('rx.noMatches')}
                </li>
              )}
              <li>
                <Button
                  type="button"
                  variant="ghost"
                  className={cn(optionLook, 'text-muted-foreground')}
                  role="option"
                  aria-selected={false}
                  onClick={() => add(freeTextLine(query.trim().slice(0, 200)))}
                >
                  <span>{t('rx.addFreeText', { text: query.trim() })}</span>
                </Button>
              </li>
            </ul>
          )}
        </div>
      </fieldset>

      {draft && signPanel}

      {editable && items.length > 0 && (
        <form
          className="flex flex-wrap items-end gap-3 border-t border-border pt-4"
          onSubmit={(e) => void saveTemplate(e)}
        >
          <div className="w-full space-y-1.5 sm:w-64">
            <Label htmlFor="rx-template-name" className={fieldLabel}>
              {t('rx.templateName')}
            </Label>
            <Input id="rx-template-name" name="templateName" required maxLength={80} />
          </div>
          <Button type="submit" variant="outline">
            {t('rx.saveTemplate')}
          </Button>
        </form>
      )}
    </div>
  );
}

const fieldLabel = 'block text-sm font-semibold';
const alertBox = 'rounded-xl bg-danger-soft px-4 py-3 text-sm font-medium text-destructive';
const noticeBox = 'rounded-xl bg-info-soft px-4 py-3 text-sm text-info';
const optionLook = 'h-auto w-full justify-start whitespace-normal py-2.5 text-left font-normal';
