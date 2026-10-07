'use client';

import { ApiError } from '@dhc/api-client';
import { Vitals, type PregnancyStatus, type VitalsBody } from '@dhc/contracts';
import { ageFrom, formatIstDateTime, istDateKey, WEIGHT_REQUIRED_UNDER_YEARS } from '@dhc/domain';
import { Button, Input, Label, NativeSelect } from '@dhc/ui-web';
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
    <form className="space-y-5" onSubmit={(e) => void save(e)} aria-label={t('vitals.title')}>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {FIELDS.map(({ key, label, step }) => (
          <div key={key} className="space-y-2">
            <Label htmlFor={`vitals-${key}`}>{t(label as 'vitals.pulse')}</Label>
            <Input
              id={`vitals-${key}`}
              name={key}
              type="number"
              inputMode="decimal"
              className="tabular"
              step={step}
              defaultValue={current?.[key] ?? ''}
              disabled={!editable}
            />
          </div>
        ))}
        {patient.gender === 'female' && (ageYears === null || ageYears >= 12) && (
          <div className="col-span-2 space-y-2 sm:col-span-1">
            <Label htmlFor="vitals-pregnancyStatus">{t('vitals.pregnancy')}</Label>
            <NativeSelect
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
            </NativeSelect>
          </div>
        )}
      </div>
      <p className="text-sm text-muted-foreground" aria-live="polite">
        {current?.bmi != null && (
          <strong data-testid="bmi" className="font-semibold text-foreground">
            {t('vitals.bmi', { bmi: current.bmi })} ·{' '}
          </strong>
        )}
        {current &&
          t('vitals.recordedBy', {
            name: current.recordedByName ?? '—',
            time: formatIstDateTime(current.updatedAt, locale),
          })}
      </p>
      {child && current?.weightKg == null && (
        <p
          className="rounded-xl bg-warning-soft p-4 text-sm font-medium text-warning-foreground"
          data-testid="child-weight"
        >
          {t('vitals.childWeight')}
        </p>
      )}
      {error && (
        <p
          role="alert"
          className="rounded-xl bg-danger-soft p-4 text-sm font-medium text-destructive"
        >
          {error}
        </p>
      )}
      {saved && (
        <p className="rounded-xl bg-success-soft p-4 text-sm font-medium text-success">
          {t('vitals.saved')}
        </p>
      )}
      {editable && (
        <Button type="submit" className="w-full sm:w-auto" disabled={busy}>
          {t('vitals.save')}
        </Button>
      )}
    </form>
  );
}
