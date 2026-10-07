'use client';

import type { ConsultationNotes, Diagnosis, Symptom } from '@dhc/contracts';
import { searchIcd10 } from '@dhc/domain';
import type { MessageKey } from '@dhc/i18n';
import Link from 'next/link';
import { useState, type KeyboardEvent } from 'react';
import { useSession } from '../session-provider';

type TextField = 'examination' | 'plan' | 'testsAdvised' | 'advice' | 'privateNotes';

const TEXT_FIELDS: { key: TextField; label: MessageKey; rows: number }[] = [
  { key: 'examination', label: 'consult.examination', rows: 3 },
  { key: 'plan', label: 'consult.plan', rows: 3 },
  { key: 'testsAdvised', label: 'consult.testsAdvised', rows: 2 },
  { key: 'advice', label: 'consult.advice', rows: 3 },
  { key: 'privateNotes', label: 'consult.privateNotes', rows: 2 },
];

/**
 * This visit's notes (PRD §6.1). Controlled by the screen, which autosaves; every edit
 * calls `onChange` with the whole document.
 */
export function NotesForm({
  notes,
  followUpDate,
  patientId,
  editable,
  onChange,
}: {
  notes: ConsultationNotes;
  followUpDate: string | null;
  patientId: string;
  editable: boolean;
  onChange(notes: ConsultationNotes, followUpDate: string | null): void;
}) {
  const { t } = useSession();
  const set = (patch: Partial<ConsultationNotes>) => onChange({ ...notes, ...patch }, followUpDate);
  const setSymptom = (i: number, patch: Partial<Symptom>) =>
    set({ symptoms: notes.symptoms.map((s, j) => (i === j ? { ...s, ...patch } : s)) });

  return (
    <fieldset className="notes" disabled={!editable}>
      <label htmlFor="chiefComplaint">{t('consult.chiefComplaint')}</label>
      <input
        id="chiefComplaint"
        value={notes.chiefComplaint}
        maxLength={500}
        onChange={(e) => set({ chiefComplaint: e.target.value })}
      />

      <h3>{t('consult.symptoms')}</h3>
      {notes.symptoms.map((s, i) => (
        <div className="symptom-row" key={i}>
          <div>
            <label htmlFor={`symptom-${i}`}>{t('consult.symptom')}</label>
            <input
              id={`symptom-${i}`}
              value={s.text}
              maxLength={200}
              onChange={(e) => setSymptom(i, { text: e.target.value })}
            />
          </div>
          <div>
            <label htmlFor={`duration-${i}`}>{t('consult.duration')}</label>
            <input
              id={`duration-${i}`}
              value={s.duration ?? ''}
              maxLength={60}
              onChange={(e) => setSymptom(i, { duration: e.target.value || null })}
            />
          </div>
          <button
            type="button"
            className="link-button"
            onClick={() => set({ symptoms: notes.symptoms.filter((_, j) => j !== i) })}
          >
            {t('consult.remove')}
          </button>
        </div>
      ))}
      {notes.symptoms.length < 20 && (
        <button
          type="button"
          className="link-button"
          onClick={() => set({ symptoms: [...notes.symptoms, { text: '', duration: null }] })}
        >
          {t('consult.addSymptom')}
        </button>
      )}

      <DiagnosisPicker diagnoses={notes.diagnoses} onChange={(diagnoses) => set({ diagnoses })} />

      {TEXT_FIELDS.map(({ key, label, rows }) => (
        <div key={key} className="note-field">
          <label htmlFor={key}>{t(label)}</label>
          <textarea
            id={key}
            rows={rows}
            value={notes[key]}
            maxLength={key === 'testsAdvised' ? 2000 : 4000}
            onChange={(e) => set({ [key]: e.target.value })}
          />
        </div>
      ))}

      <div className="follow-up">
        <div>
          <label htmlFor="followUpDate">{t('consult.followUp')}</label>
          <input
            id="followUpDate"
            type="date"
            value={followUpDate ?? ''}
            onChange={(e) => onChange(notes, e.target.value || null)}
          />
        </div>
        {followUpDate && (
          <Link
            className="button-link secondary"
            href={`/clinic/appointments/new?patientId=${patientId}&date=${followUpDate}`}
          >
            {t('consult.bookFollowUp')}
          </Link>
        )}
      </div>
    </fieldset>
  );
}

/** ICD-10 search with free text allowed (PRD §6.1). */
function DiagnosisPicker({
  diagnoses,
  onChange,
}: {
  diagnoses: Diagnosis[];
  onChange(diagnoses: Diagnosis[]): void;
}) {
  const { t } = useSession();
  const [query, setQuery] = useState('');
  const matches = searchIcd10(query, 8).filter((m) => !diagnoses.some((d) => d.code === m.code));
  const text = query.trim();

  const add = (d: Diagnosis) => {
    if (diagnoses.length >= 10) return;
    onChange([...diagnoses, d]);
    setQuery('');
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const first = matches[0];
    if (first) add({ code: first.code, label: first.label });
    else if (text) add({ code: null, label: text.slice(0, 200) });
  };

  return (
    <div className="diagnosis">
      <label htmlFor="diagnosis-search">{t('consult.diagnosis')}</label>
      {diagnoses.length > 0 && (
        <ul className="diagnosis-list" data-testid="diagnoses">
          {diagnoses.map((d, i) => (
            <li key={`${d.code ?? 'free'}-${i}`} className="tag">
              {d.code && <strong>{d.code} </strong>}
              {d.label}
              <button
                type="button"
                className="link-button"
                aria-label={`${t('consult.remove')} ${d.label}`}
                onClick={() => onChange(diagnoses.filter((_, j) => j !== i))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <input
        id="diagnosis-search"
        value={query}
        placeholder={t('consult.diagnosisSearch')}
        autoComplete="off"
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKey}
      />
      {text && (
        <ul className="pick-list" role="listbox" aria-label={t('consult.diagnosisSearch')}>
          {matches.map((m) => (
            <li key={m.code}>
              <button
                type="button"
                className="secondary"
                role="option"
                aria-selected={false}
                onClick={() => add({ code: m.code, label: m.label })}
              >
                <strong>{m.code}</strong> {m.label}
              </button>
            </li>
          ))}
          <li>
            <button
              type="button"
              className="secondary"
              role="option"
              aria-selected={false}
              onClick={() => add({ code: null, label: text.slice(0, 200) })}
            >
              {t('consult.addFreeText', { text })}
            </button>
          </li>
        </ul>
      )}
    </div>
  );
}
