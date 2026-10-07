'use client';

import { ApiError } from '@dhc/api-client';
import {
  Allergy,
  CurrentMedication,
  MedicalCondition,
  type ChartSource,
  type PatientChart,
} from '@dhc/contracts';
import { Button, Input, Label, cn } from '@dhc/ui-web';
import { Plus, TriangleAlert } from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';
import type { MessageKey } from '@dhc/i18n';
import { useSession } from '../session-provider';

type Kind = 'allergies' | 'conditions' | 'medications';

interface Entry {
  id: string;
  source: ChartSource;
  label: ReactNode;
}

/**
 * The context panel's chart (PRD §6.1): allergies highlighted, conditions, current
 * medicines and recent visits. Doctors add entries and remove them with a reason; the
 * record keeps removed entries.
 */
export function ChartPanel({
  chart,
  editable,
  onChange,
}: {
  chart: PatientChart;
  editable: boolean;
  onChange(chart: PatientChart): void;
}) {
  const { t } = useSession();
  const allergies: Entry[] = chart.allergies.map((a) => ({
    id: a.id,
    source: a.source,
    label: (
      <>
        <strong>{a.substance}</strong>
        {a.reaction && ` · ${a.reaction}`}
      </>
    ),
  }));
  const conditions: Entry[] = chart.conditions.map((c) => ({
    id: c.id,
    source: c.source,
    label: (
      <>
        {c.name}
        {c.icd10Code && <span className="tabular text-muted-foreground"> {c.icd10Code}</span>}
      </>
    ),
  }));
  const medications: Entry[] = chart.medications.map((m) => ({
    id: m.id,
    source: m.source,
    label: (
      <>
        {m.name}
        {m.dose && <span className="text-muted-foreground"> · {m.dose}</span>}
      </>
    ),
  }));

  return (
    <div className="mt-1 divide-y divide-border" aria-label={t('chart.title')}>
      <ChartSection
        kind="allergies"
        title="chart.allergies"
        empty="chart.noAllergies"
        entries={allergies}
        chart={chart}
        editable={editable}
        onChange={onChange}
        danger
      />
      <ChartSection
        kind="conditions"
        title="chart.conditions"
        empty="chart.none"
        entries={conditions}
        chart={chart}
        editable={editable}
        onChange={onChange}
      />
      <ChartSection
        kind="medications"
        title="chart.medications"
        empty="chart.none"
        entries={medications}
        chart={chart}
        editable={editable}
        onChange={onChange}
      />
      <section className="py-4 last:pb-0">
        <h3 className={sectionHeading}>{t('chart.recentVisits')}</h3>
        {chart.recentVisits.length === 0 ? (
          <p className={emptyText}>{t('chart.noVisits')}</p>
        ) : (
          <ul className="mt-2 space-y-2" data-testid="recent-visits">
            {chart.recentVisits.map((v) => (
              <li
                key={v.appointmentId}
                className="rounded-xl border border-border px-3 py-2.5 text-sm [overflow-wrap:anywhere]"
              >
                <strong className="tabular">{v.date}</strong>
                {v.doctorName && <span className="text-muted-foreground"> · {v.doctorName}</span>}
                <br />
                {v.diagnoses.map((d) => d.label).join(', ') || v.chiefComplaint}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

const FIELDS: Record<Kind, { name: string; label: MessageKey; required: boolean }[]> = {
  allergies: [
    { name: 'substance', label: 'chart.substance', required: true },
    { name: 'reaction', label: 'chart.reaction', required: false },
  ],
  conditions: [
    { name: 'name', label: 'chart.conditionName', required: true },
    { name: 'icd10Code', label: 'chart.icd10', required: false },
  ],
  medications: [
    { name: 'name', label: 'chart.medicineName', required: true },
    { name: 'dose', label: 'chart.dose', required: false },
  ],
};

function ChartSection({
  kind,
  title,
  empty,
  entries,
  chart,
  editable,
  onChange,
  danger = false,
}: {
  kind: Kind;
  title: MessageKey;
  empty: MessageKey;
  entries: Entry[];
  chart: PatientChart;
  editable: boolean;
  onChange(chart: PatientChart): void;
  danger?: boolean;
}) {
  const { api, signOut, t } = useSession();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return void signOut('expired');
      setError(e instanceof ApiError ? e.message : t('error.network'));
    } finally {
      setBusy(false);
    }
  }

  const add = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const body: Record<string, string | null> = {};
    for (const f of FIELDS[kind]) {
      const value = String(form.get(f.name) ?? '').trim();
      body[f.name] = f.required ? value : value || null;
    }
    body.source = form.get('patientReported') ? 'patient' : 'doctor';
    void run(async () => {
      const url = `/patients/${chart.patientId}/${kind}`;
      if (kind === 'allergies') {
        const a = await api.request('POST', url, { schema: Allergy, body });
        onChange({ ...chart, allergies: [...chart.allergies, a] });
      } else if (kind === 'conditions') {
        const c = await api.request('POST', url, { schema: MedicalCondition, body });
        onChange({ ...chart, conditions: [...chart.conditions, c] });
      } else {
        const m = await api.request('POST', url, { schema: CurrentMedication, body });
        onChange({ ...chart, medications: [...chart.medications, m] });
      }
      setAdding(false);
    });
  };

  const remove = (event: FormEvent<HTMLFormElement>, id: string) => {
    event.preventDefault();
    const reason = String(new FormData(event.currentTarget).get('reason') ?? '').trim();
    void run(async () => {
      await api.removeChartEntry(chart.patientId, kind, id, reason);
      onChange({ ...chart, [kind]: chart[kind].filter((e) => e.id !== id) });
      setRemoving(null);
    });
  };

  return (
    <section data-testid={`chart-${kind}`} className="py-4 first:pt-3">
      <div className="flex min-h-11 items-center justify-between gap-2">
        <h3 className={sectionHeading}>{t(title)}</h3>
        {editable && !adding && (
          <Button
            type="button"
            variant="link"
            className="-mr-2 px-2"
            onClick={() => setAdding(true)}
          >
            <Plus aria-hidden />
            {t('chart.add')}
          </Button>
        )}
      </div>
      {entries.length === 0 ? (
        <p className={emptyText}>{t(empty)}</p>
      ) : (
        <ul className="space-y-2">
          {entries.map((e) => (
            <li
              key={e.id}
              className={cn(
                'rounded-xl px-3 py-2 text-sm [overflow-wrap:anywhere]',
                danger ? 'bg-danger-soft text-destructive' : 'bg-muted/60',
              )}
            >
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                {danger && <TriangleAlert aria-hidden className="size-4 shrink-0" />}
                <span className="min-w-0">{e.label}</span>
                {e.source === 'patient' && (
                  <span className="inline-flex items-center rounded-full bg-warning-soft px-2 py-0.5 text-[11px] font-semibold text-warning-foreground">
                    {t('chart.unverified')}
                  </span>
                )}
                {editable && removing !== e.id && (
                  <Button
                    type="button"
                    variant="link"
                    className="ml-auto h-auto min-h-11 px-1 text-xs text-muted-foreground"
                    onClick={() => setRemoving(e.id)}
                  >
                    {t('chart.remove')}
                  </Button>
                )}
              </div>
              {removing === e.id && (
                <form
                  className="mt-2 space-y-2 border-t border-border/70 pt-3 text-foreground"
                  onSubmit={(ev) => remove(ev, e.id)}
                >
                  <div className="space-y-1.5">
                    <Label htmlFor={`remove-${e.id}`} className="block text-sm font-semibold">
                      {t('chart.removeReason')}
                    </Label>
                    <Input id={`remove-${e.id}`} name="reason" required maxLength={300} />
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button type="submit" variant="destructive" disabled={busy}>
                      {t('chart.remove')}
                    </Button>
                    <Button type="button" variant="outline" onClick={() => setRemoving(null)}>
                      {t('common.cancel')}
                    </Button>
                  </div>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
      {adding && (
        <form
          className="mt-3 space-y-3 rounded-xl border border-dashed border-border p-3"
          onSubmit={add}
        >
          {FIELDS[kind].map((f) => (
            <div key={f.name} className="space-y-1.5">
              <Label htmlFor={`${kind}-${f.name}`} className="block text-sm font-semibold">
                {t(f.label)}
              </Label>
              <Input id={`${kind}-${f.name}`} name={f.name} required={f.required} maxLength={200} />
            </div>
          ))}
          <label className="flex min-h-11 cursor-pointer items-center gap-2.5 text-sm">
            <input
              type="checkbox"
              name="patientReported"
              className="size-4 shrink-0 accent-primary"
            />{' '}
            {t('chart.patientReported')}
          </label>
          <div className="confirm-actions flex flex-wrap gap-2">
            <Button type="submit" disabled={busy}>
              {t('chart.add')}
            </Button>
            <Button type="button" variant="outline" onClick={() => setAdding(false)}>
              {t('common.cancel')}
            </Button>
          </div>
        </form>
      )}
      {error && (
        <p
          role="alert"
          className="mt-2 rounded-xl bg-danger-soft px-3 py-2 text-sm font-medium text-destructive"
        >
          {error}
        </p>
      )}
    </section>
  );
}

const sectionHeading = 'text-[11px] font-bold uppercase tracking-wide text-muted-foreground';
const emptyText = 'text-sm text-muted-foreground';
