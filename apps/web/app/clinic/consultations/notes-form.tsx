'use client';

import type { ConsultationNotes, Diagnosis, Symptom } from '@dhc/contracts';
import { searchIcd10 } from '@dhc/domain';
import type { MessageKey } from '@dhc/i18n';
import { Button, Input, Label, Textarea, buttonVariants, cn } from '@dhc/ui-web';
import { CalendarPlus, Plus, Search } from 'lucide-react';
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
    <fieldset className="m-0 min-w-0 space-y-6 border-0 p-0" disabled={!editable}>
      <div className="space-y-1.5">
        <Label htmlFor="chiefComplaint" className={fieldLabel}>
          {t('consult.chiefComplaint')}
        </Label>
        <Input
          id="chiefComplaint"
          value={notes.chiefComplaint}
          maxLength={500}
          onChange={(e) => set({ chiefComplaint: e.target.value })}
        />
      </div>

      <div className="space-y-3 border-t border-border pt-5">
        <h3 className={groupHeading}>{t('consult.symptoms')}</h3>
        {notes.symptoms.map((s, i) => (
          <div
            className="grid gap-2 rounded-xl border border-border p-3 sm:grid-cols-[2fr_1fr_auto] sm:items-end sm:border-0 sm:p-0"
            key={i}
          >
            <div className="min-w-0 space-y-1.5">
              <Label htmlFor={`symptom-${i}`} className={fieldLabel}>
                {t('consult.symptom')}
              </Label>
              <Input
                id={`symptom-${i}`}
                value={s.text}
                maxLength={200}
                onChange={(e) => setSymptom(i, { text: e.target.value })}
              />
            </div>
            <div className="min-w-0 space-y-1.5">
              <Label htmlFor={`duration-${i}`} className={fieldLabel}>
                {t('consult.duration')}
              </Label>
              <Input
                id={`duration-${i}`}
                value={s.duration ?? ''}
                maxLength={60}
                onChange={(e) => setSymptom(i, { duration: e.target.value || null })}
              />
            </div>
            <Button
              type="button"
              variant="link"
              className="justify-self-start px-0 text-destructive sm:px-3"
              onClick={() => set({ symptoms: notes.symptoms.filter((_, j) => j !== i) })}
            >
              {t('consult.remove')}
            </Button>
          </div>
        ))}
        {notes.symptoms.length < 20 && (
          <Button
            type="button"
            variant="link"
            className="px-0"
            onClick={() => set({ symptoms: [...notes.symptoms, { text: '', duration: null }] })}
          >
            <Plus aria-hidden />
            {t('consult.addSymptom')}
          </Button>
        )}
      </div>

      <div className="border-t border-border pt-5">
        <DiagnosisPicker diagnoses={notes.diagnoses} onChange={(diagnoses) => set({ diagnoses })} />
      </div>

      <div className="space-y-5 border-t border-border pt-5">
        {TEXT_FIELDS.map(({ key, label, rows }) => (
          <div key={key} className="space-y-1.5">
            <Label htmlFor={key} className={fieldLabel}>
              {t(label)}
            </Label>
            <Textarea
              id={key}
              rows={rows}
              value={notes[key]}
              maxLength={key === 'testsAdvised' ? 2000 : 4000}
              onChange={(e) => set({ [key]: e.target.value })}
              className={cn(textareaLook, key === 'privateNotes' && 'border-dashed bg-muted/40')}
            />
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-end gap-3 border-t border-border pt-5">
        <div className="w-full space-y-1.5 sm:w-56">
          <Label htmlFor="followUpDate" className={fieldLabel}>
            {t('consult.followUp')}
          </Label>
          <Input
            id="followUpDate"
            type="date"
            value={followUpDate ?? ''}
            onChange={(e) => onChange(notes, e.target.value || null)}
          />
        </div>
        {followUpDate && (
          <Link
            className={buttonVariants({ variant: 'outline' })}
            href={`/clinic/appointments/new?patientId=${patientId}&date=${followUpDate}`}
          >
            <CalendarPlus aria-hidden />
            {t('consult.bookFollowUp')}
          </Link>
        )}
      </div>
    </fieldset>
  );
}

const fieldLabel = 'block text-sm font-semibold';
const groupHeading = 'text-[11px] font-bold uppercase tracking-wide text-muted-foreground';
/** Brings ui-web's Textarea in line with Input (radius, surface, focus ring). */
const textareaLook =
  'rounded-xl bg-card px-3.5 py-2.5 shadow-xs transition-[border-color,box-shadow] focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20';

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
    <div className="space-y-2">
      <Label htmlFor="diagnosis-search" className={fieldLabel}>
        {t('consult.diagnosis')}
      </Label>
      {diagnoses.length > 0 && (
        <ul className="flex flex-wrap gap-2" data-testid="diagnoses">
          {diagnoses.map((d, i) => (
            <li
              key={`${d.code ?? 'free'}-${i}`}
              className="inline-flex min-h-11 max-w-full items-center rounded-full bg-accent pl-3.5 text-sm text-accent-foreground"
            >
              <span className="min-w-0 py-2 [overflow-wrap:anywhere]">
                {d.code && <strong className="tabular">{d.code} </strong>}
                {d.label}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="shrink-0 rounded-full text-base hover:bg-primary/10"
                aria-label={`${t('consult.remove')} ${d.label}`}
                onClick={() => onChange(diagnoses.filter((_, j) => j !== i))}
              >
                ×
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="relative">
        <Search
          aria-hidden
          className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          id="diagnosis-search"
          value={query}
          placeholder={t('consult.diagnosisSearch')}
          autoComplete="off"
          className="pl-10"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKey}
        />
      </div>
      {text && (
        <ul
          className="max-h-80 space-y-0.5 overflow-y-auto rounded-xl border border-border bg-card p-1 shadow-soft"
          role="listbox"
          aria-label={t('consult.diagnosisSearch')}
        >
          {matches.map((m) => (
            <li key={m.code}>
              <Button
                type="button"
                variant="ghost"
                className={optionLook}
                role="option"
                aria-selected={false}
                onClick={() => add({ code: m.code, label: m.label })}
              >
                <span>
                  <strong className="tabular text-primary">{m.code}</strong> {m.label}
                </span>
              </Button>
            </li>
          ))}
          <li>
            <Button
              type="button"
              variant="ghost"
              className={cn(optionLook, 'text-muted-foreground')}
              role="option"
              aria-selected={false}
              onClick={() => add({ code: null, label: text.slice(0, 200) })}
            >
              <span>{t('consult.addFreeText', { text })}</span>
            </Button>
          </li>
        </ul>
      )}
    </div>
  );
}

const optionLook = 'h-auto w-full justify-start whitespace-normal py-2.5 text-left font-normal';
