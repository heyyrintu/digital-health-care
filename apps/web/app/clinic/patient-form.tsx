'use client';

import { ApiError } from '@dhc/api-client';
import {
  BLOOD_GROUPS,
  PatientListResponse,
  type PatientDetail,
  type PatientRef,
  type UpdatePatientBody,
} from '@dhc/contracts';
import { useState, type FormEvent, type ReactNode } from 'react';
import { useSession } from './session-provider';

/** Demographic fields shared by registration and editing. */
export function PatientForm({
  initial,
  submitLabel,
  busy,
  onSubmit,
  children,
}: {
  initial?: PatientDetail;
  submitLabel: string;
  busy: boolean;
  /** Receives the fields as typed; empty optional fields become null. */
  onSubmit(body: UpdatePatientBody & { name: string }): void;
  /** Extra controls rendered above the submit button (e.g. tags). */
  children?: ReactNode;
}) {
  const { t } = useSession();
  const [guardian, setGuardian] = useState<PatientRef | null>(initial?.guardian ?? null);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const text = (key: string) => {
      const value = String(data.get(key) ?? '').trim();
      return value === '' ? null : value;
    };
    onSubmit({
      name: text('name') ?? '',
      phone: text('phone'),
      dob: text('dob'),
      gender: text('gender') as UpdatePatientBody['gender'],
      email: text('email'),
      address: text('address'),
      bloodGroup: text('bloodGroup') as UpdatePatientBody['bloodGroup'],
      language: (text('language') ?? 'en') as 'en' | 'hi',
      emergencyContactName: text('emergencyContactName'),
      emergencyContactPhone: text('emergencyContactPhone'),
      guardianPatientId: guardian?.id ?? null,
    });
  }

  const today = new Date().toISOString().slice(0, 10);

  return (
    <form className="patient-form" onSubmit={submit}>
      <div className="field wide">
        <label htmlFor="name">{t('patient.name')}</label>
        <input
          id="name"
          name="name"
          required
          maxLength={120}
          autoComplete="off"
          defaultValue={initial?.name}
        />
      </div>
      <div className="field">
        <label htmlFor="phone">{t('patient.phone')}</label>
        <input
          id="phone"
          name="phone"
          type="tel"
          inputMode="tel"
          maxLength={20}
          autoComplete="off"
          defaultValue={initial?.phone ?? ''}
        />
      </div>
      <div className="field">
        <label htmlFor="dob">{t('patient.dob')}</label>
        <input id="dob" name="dob" type="date" max={today} defaultValue={initial?.dob ?? ''} />
      </div>
      <div className="field">
        <label htmlFor="gender">{t('patient.gender')}</label>
        <select id="gender" name="gender" defaultValue={initial?.gender ?? ''}>
          <option value="">—</option>
          <option value="female">{t('gender.female')}</option>
          <option value="male">{t('gender.male')}</option>
          <option value="other">{t('gender.other')}</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor="language">{t('patient.language')}</label>
        <select id="language" name="language" defaultValue={initial?.language ?? 'en'}>
          <option value="en">{t('language.en')}</option>
          <option value="hi">{t('language.hi')}</option>
        </select>
      </div>

      <GuardianPicker value={guardian} onChange={setGuardian} excludeId={initial?.id} />

      <div className="field">
        <label htmlFor="email">{t('patient.email')}</label>
        <input
          id="email"
          name="email"
          type="email"
          maxLength={254}
          defaultValue={initial?.email ?? ''}
        />
      </div>
      <div className="field">
        <label htmlFor="bloodGroup">{t('patient.bloodGroup')}</label>
        <select id="bloodGroup" name="bloodGroup" defaultValue={initial?.bloodGroup ?? ''}>
          <option value="">—</option>
          {BLOOD_GROUPS.map((g) => (
            <option key={g} value={g}>
              {g}
            </option>
          ))}
        </select>
      </div>
      <div className="field wide">
        <label htmlFor="address">{t('patient.address')}</label>
        <input id="address" name="address" maxLength={300} defaultValue={initial?.address ?? ''} />
      </div>
      <div className="field">
        <label htmlFor="emergencyContactName">{t('patient.emergencyName')}</label>
        <input
          id="emergencyContactName"
          name="emergencyContactName"
          maxLength={120}
          defaultValue={initial?.emergencyContactName ?? ''}
        />
      </div>
      <div className="field">
        <label htmlFor="emergencyContactPhone">{t('patient.emergencyPhone')}</label>
        <input
          id="emergencyContactPhone"
          name="emergencyContactPhone"
          type="tel"
          maxLength={20}
          defaultValue={initial?.emergencyContactPhone ?? ''}
        />
      </div>

      {children}

      <div className="field wide">
        <button type="submit" disabled={busy}>
          {submitLabel}
        </button>
      </div>
    </form>
  );
}

/** Search for the adult who looks after this patient (one level: guardians have no guardian). */
function GuardianPicker({
  value,
  onChange,
  excludeId,
}: {
  value: PatientRef | null;
  onChange(value: PatientRef | null): void;
  excludeId?: string;
}) {
  const { api, t } = useSession();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PatientRef[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function find() {
    const q = query.trim();
    if (!q) return;
    setError(null);
    try {
      const found = await api.request('GET', '/patients', {
        schema: PatientListResponse,
        query: { q, limit: 8 },
      });
      setResults(found.data.filter((p) => p.id !== excludeId));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('error.network'));
    }
  }

  return (
    <fieldset className="field wide guardian">
      <legend>{t('patient.guardian')}</legend>
      <p className="hint">{t('patient.guardianHint')}</p>
      {value ? (
        <p data-testid="guardian-selected">
          <strong>{value.name}</strong> · {value.uhid}{' '}
          <button type="button" className="secondary" onClick={() => onChange(null)}>
            {t('patient.guardianRemove')}
          </button>
        </p>
      ) : (
        <>
          <div className="search">
            <label htmlFor="guardian-q" className="visually-hidden">
              {t('patient.guardianSearch')}
            </label>
            <input
              id="guardian-q"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                // Enter searches here instead of submitting the whole form.
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void find();
                }
              }}
              placeholder={t('dashboard.searchHint')}
            />
            <button type="button" className="secondary" onClick={() => void find()}>
              {t('patient.guardianSearch')}
            </button>
          </div>
          {error && <p className="alert">{error}</p>}
          {results && results.length === 0 && <p className="hint">{t('dashboard.noPatients')}</p>}
          {results && results.length > 0 && (
            <ul className="pick-list">
              {results.map((p) => (
                <li key={p.id}>
                  {p.name} · {p.uhid}{' '}
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => {
                      onChange({ id: p.id, uhid: p.uhid, name: p.name });
                      setResults(null);
                      setQuery('');
                    }}
                  >
                    {t('patient.choose')}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </fieldset>
  );
}
