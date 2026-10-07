'use client';

import { ApiError } from '@dhc/api-client';
import { Vitals, type PregnancyStatus, type VitalsBody } from '@dhc/contracts';
import { ageFrom, formatIstDateTime, istDateKey, WEIGHT_REQUIRED_UNDER_YEARS } from '@dhc/domain';
import { useState, type FormEvent } from 'react';
import { useSession } from './session-provider';

type NumberField = Exclude<keyof VitalsBody, 'pregnancyStatus'>;

const FIELDS: { key: NumberField; label: string; step: string }[] = [
  { key: 'bpSystolic', label: 'vitals.systolic', step: '1' },
  { key: 'bpDiastolic', label: 'vitals.diastolic', step: '1' },
  { key: 'pulse', label: 'vitals.pulse', step: '1' },
  { key: 'temperatureC', label: 'vitals.temperature', step: '0.1' },
  { key: 'spo2', label: 'vitals.spo2', step: '1' },
  { key: 'weightKg', label: 'vitals.weight', step: '0.01' },
  { key: 'heightCm', label: 'vitals.height', step: '0.1' },
  { key: 'painScore', label: 'vitals.pain', step: '1' },
];

const PREGNANCY: PregnancyStatus[] = ['not_pregnant', 'pregnant', 'breastfeeding'];

/**
 * Vitals for one visit (PRD §6.1), recorded by front desk or the doctor. Saving sends
 * the whole set: a cleared box clears that reading.
 */
export function VitalsForm({
  appointmentId,
  vitals,
  patient,
  editable,
  onSaved,
}: {
  appointmentId: string;
  vitals: Vitals | null;
  patient: { dob: string | null; gender: string | null };
  editable: boolean;
  onSaved?(v: Vitals): void;
}) {
  const { api, locale, signOut, t } = useSession();
  const [current, setCurrent] = useState(vitals);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const ageYears = patient.dob ? ageFrom(patient.dob, istDateKey(new Date())).years : null;
  const child = ageYears !== null && ageYears < WEIGHT_REQUIRED_UNDER_YEARS;

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const body: VitalsBody = {};
    for (const { key } of FIELDS) {
      const raw = String(form.get(key) ?? '').trim();
      body[key] = raw === '' ? null : Number(raw);
    }
    const pregnancy = String(form.get('pregnancyStatus') ?? '');
    body.pregnancyStatus = pregnancy ? (pregnancy as PregnancyStatus) : null;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const next = await api.request('PUT', `/appointments/${appointmentId}/vitals`, {
        schema: Vitals,
        body,
      });
      setCurrent(next);
      setSaved(true);
      onSaved?.(next);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return void signOut('expired');
      setError(e instanceof ApiError ? e.message : t('error.network'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="vitals" onSubmit={(e) => void save(e)} aria-label={t('vitals.title')}>
      <div className="vitals-grid">
        {FIELDS.map(({ key, label, step }) => (
          <div key={key}>
            <label htmlFor={`vitals-${key}`}>{t(label as 'vitals.pulse')}</label>
            <input
              id={`vitals-${key}`}
              name={key}
              type="number"
              inputMode="decimal"
              step={step}
              defaultValue={current?.[key] ?? ''}
              disabled={!editable}
            />
          </div>
        ))}
        {patient.gender === 'female' && (ageYears === null || ageYears >= 12) && (
          <div>
            <label htmlFor="vitals-pregnancyStatus">{t('vitals.pregnancy')}</label>
            <select
              id="vitals-pregnancyStatus"
              name="pregnancyStatus"
              defaultValue={current?.pregnancyStatus ?? ''}
              disabled={!editable}
            >
              <option value="">{t('vitals.pregnancy.none')}</option>
              {PREGNANCY.map((p) => (
                <option key={p} value={p}>
                  {t(`vitals.pregnancy.${p}`)}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
      <p className="hint" aria-live="polite">
        {current?.bmi != null && (
          <strong data-testid="bmi">{t('vitals.bmi', { bmi: current.bmi })} · </strong>
        )}
        {current &&
          t('vitals.recordedBy', {
            name: current.recordedByName ?? '—',
            time: formatIstDateTime(current.updatedAt, locale),
          })}
      </p>
      {child && current?.weightKg == null && (
        <p className="notice" data-testid="child-weight">
          {t('vitals.childWeight')}
        </p>
      )}
      {error && (
        <p role="alert" className="alert">
          {error}
        </p>
      )}
      {saved && <p className="notice">{t('vitals.saved')}</p>}
      {editable && (
        <button type="submit" disabled={busy}>
          {t('vitals.save')}
        </button>
      )}
    </form>
  );
}
