'use client';

import { ApiError } from '@dhc/api-client';
import {
  Allergy,
  CurrentMedication,
  MedicalCondition,
  type ChartSource,
  type PatientChart,
} from '@dhc/contracts';
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
        {c.icd10Code && <span className="hint"> {c.icd10Code}</span>}
      </>
    ),
  }));
  const medications: Entry[] = chart.medications.map((m) => ({
    id: m.id,
    source: m.source,
    label: (
      <>
        {m.name}
        {m.dose && <span className="hint"> · {m.dose}</span>}
      </>
    ),
  }));

  return (
    <div className="chart" aria-label={t('chart.title')}>
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
      <section>
        <h3>{t('chart.recentVisits')}</h3>
        {chart.recentVisits.length === 0 ? (
          <p className="hint">{t('chart.noVisits')}</p>
        ) : (
          <ul className="chart-list" data-testid="recent-visits">
            {chart.recentVisits.map((v) => (
              <li key={v.appointmentId}>
                <strong>{v.date}</strong>
                {v.doctorName && <span className="hint"> · {v.doctorName}</span>}
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
    <section data-testid={`chart-${kind}`}>
      <div className="card-header">
        <h3>{t(title)}</h3>
        {editable && !adding && (
          <button type="button" className="link-button" onClick={() => setAdding(true)}>
            {t('chart.add')}
          </button>
        )}
      </div>
      {entries.length === 0 ? (
        <p className="hint">{t(empty)}</p>
      ) : (
        <ul className={`chart-list${danger ? ' danger' : ''}`}>
          {entries.map((e) => (
            <li key={e.id}>
              {e.label}
              {e.source === 'patient' && <span className="pill">{t('chart.unverified')}</span>}
              {editable && removing !== e.id && (
                <button type="button" className="link-button" onClick={() => setRemoving(e.id)}>
                  {t('chart.remove')}
                </button>
              )}
              {removing === e.id && (
                <form className="inline-form" onSubmit={(ev) => remove(ev, e.id)}>
                  <div>
                    <label htmlFor={`remove-${e.id}`}>{t('chart.removeReason')}</label>
                    <input id={`remove-${e.id}`} name="reason" required maxLength={300} />
                  </div>
                  <button type="submit" disabled={busy}>
                    {t('chart.remove')}
                  </button>
                  <button type="button" className="secondary" onClick={() => setRemoving(null)}>
                    {t('common.cancel')}
                  </button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
      {adding && (
        <form className="chart-add" onSubmit={add}>
          {FIELDS[kind].map((f) => (
            <div key={f.name}>
              <label htmlFor={`${kind}-${f.name}`}>{t(f.label)}</label>
              <input id={`${kind}-${f.name}`} name={f.name} required={f.required} maxLength={200} />
            </div>
          ))}
          <label className="check">
            <input type="checkbox" name="patientReported" /> {t('chart.patientReported')}
          </label>
          <div className="confirm-actions">
            <button type="submit" disabled={busy}>
              {t('chart.add')}
            </button>
            <button type="button" className="secondary" onClick={() => setAdding(false)}>
              {t('common.cancel')}
            </button>
          </div>
        </form>
      )}
      {error && (
        <p role="alert" className="alert">
          {error}
        </p>
      )}
    </section>
  );
}
