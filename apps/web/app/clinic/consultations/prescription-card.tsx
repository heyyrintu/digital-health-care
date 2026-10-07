'use client';

import { ApiError } from '@dhc/api-client';
import {
  LastPrescription,
  MedicineList,
  Prescription,
  PrescriptionTemplate,
  PrescriptionTemplateList,
  PrescriptionView,
  type Language,
  type Medicine,
  type PrescriptionItem,
  type TemplateItem,
} from '@dhc/contracts';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useSession } from '../session-provider';
import { remarksOf, RxLine } from './rx-line';

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
 * the notes; signing, safety checks and the PDF come in later slices.
 */
export function PrescriptionCard({
  appointmentId,
  patientId,
}: {
  appointmentId: string;
  patientId: string;
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
      <p role="alert" className="alert">
        {error}
      </p>
    ) : (
      <p aria-live="polite">{t('common.loading')}</p>
    );
  }

  const editable = view.canEdit && state !== 'stale';
  const status =
    state === 'saving'
      ? t('consult.saving')
      : state === 'dirty' || state === 'error'
        ? t('consult.unsaved')
        : state === 'saved'
          ? t('rx.saved')
          : '';

  return (
    <div className="rx">
      <div className="card-header">
        <h2>{t('rx.title')}</h2>
        <p className="hint save-status" aria-live="polite" data-testid="rx-save-status">
          {status}
        </p>
      </div>
      {!view.canEdit && <p className="notice">{t('rx.readOnly')}</p>}
      {state === 'stale' && (
        <p role="alert" className="alert">
          {t('rx.stale')}{' '}
          <button type="button" className="link-button" onClick={() => void load()}>
            {t('consult.reload')}
          </button>
        </p>
      )}
      {error && state !== 'stale' && (
        <p role="alert" className="alert">
          {error}
        </p>
      )}
      {notice && <p className="notice">{notice}</p>}

      <fieldset className="rx-body" disabled={!editable}>
        <div className="rx-tools">
          <div>
            <label htmlFor="rx-language">{t('rx.language')}</label>
            <select
              id="rx-language"
              value={language}
              onChange={(e) => edit(items, e.target.value as Language)}
            >
              <option value="en">English</option>
              <option value="hi">हिन्दी</option>
            </select>
          </div>
          <button type="button" className="secondary" onClick={() => void repeatLast()}>
            {t('rx.repeatLast')}
          </button>
          {templates.length > 0 && (
            <div className="rx-template-pick">
              <label htmlFor="rx-template">{t('rx.templates')}</label>
              <select
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
              </select>
              <button
                type="button"
                className="secondary"
                disabled={!templateId}
                onClick={applyTemplate}
              >
                {t('rx.applyTemplate')}
              </button>
              <button
                type="button"
                className="link-button"
                disabled={!templateId}
                onClick={() => void deleteTemplate()}
              >
                {t('rx.deleteTemplate')}
              </button>
            </div>
          )}
        </div>

        {items.length === 0 ? (
          <p className="hint">{t('rx.empty')}</p>
        ) : (
          <ol className="rx-lines">
            {items.map((item, i) => (
              <RxLine
                key={item.id}
                item={item}
                index={i}
                language={language}
                editable={editable}
                onChange={(next) => edit(items.map((x) => (x.id === next.id ? next : x)))}
                onRemove={() => edit(items.filter((x) => x.id !== item.id))}
              />
            ))}
          </ol>
        )}

        <div className="rx-search">
          <label htmlFor="rx-search">{t('rx.search')}</label>
          <input
            id="rx-search"
            value={query}
            autoComplete="off"
            onChange={(e) => setQuery(e.target.value)}
          />
          {query.trim().length >= 2 && (
            <ul className="pick-list" role="listbox" aria-label={t('rx.search')}>
              {matches?.map((m) => (
                <li key={m.id}>
                  <button
                    type="button"
                    className="secondary"
                    role="option"
                    aria-selected={false}
                    onClick={() => add(lineFromMedicine(m))}
                  >
                    <strong>{m.name}</strong> <span className="hint">{m.composition}</span>
                  </button>
                </li>
              ))}
              {matches?.length === 0 && <li className="hint">{t('rx.noMatches')}</li>}
              <li>
                <button
                  type="button"
                  className="secondary"
                  role="option"
                  aria-selected={false}
                  onClick={() => add(freeTextLine(query.trim().slice(0, 200)))}
                >
                  {t('rx.addFreeText', { text: query.trim() })}
                </button>
              </li>
            </ul>
          )}
        </div>
      </fieldset>

      {editable && items.length > 0 && (
        <form className="inline-form rx-save-template" onSubmit={(e) => void saveTemplate(e)}>
          <div>
            <label htmlFor="rx-template-name">{t('rx.templateName')}</label>
            <input id="rx-template-name" name="templateName" required maxLength={80} />
          </div>
          <button type="submit">{t('rx.saveTemplate')}</button>
        </form>
      )}
    </div>
  );
}
