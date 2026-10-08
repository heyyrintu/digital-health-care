'use client';

import { ApiError } from '@dhc/api-client';
import {
  BLOOD_GROUPS,
  PatientListResponse,
  type PatientDetail,
  type PatientRef,
  type UpdatePatientBody,
} from '@dhc/contracts';
import { Button, Input, Label, NativeSelect } from '@dhc/ui-web';
import { useState, type FormEvent, type ReactNode } from 'react';
import { useSession } from './session-provider';

const field = 'field grid min-w-0 content-start gap-1.5';
const wideField = `${field} wide sm:col-span-2`;

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
    <form className="patient-form grid grid-cols-1 gap-4 sm:grid-cols-2" onSubmit={submit}>
      <div className={wideField}>
        <Label htmlFor="name">{t('patient.name')}</Label>
        <Input
          id="name"
          name="name"
          required
          maxLength={120}
          autoComplete="off"
          defaultValue={initial?.name}
        />
      </div>
      <div className={field}>
        <Label htmlFor="phone">{t('patient.phone')}</Label>
        <Input
          id="phone"
          name="phone"
          type="tel"
          inputMode="tel"
          maxLength={20}
          autoComplete="off"
          defaultValue={initial?.phone ?? ''}
        />
      </div>
      <div className={field}>
        <Label htmlFor="dob">{t('patient.dob')}</Label>
        <Input id="dob" name="dob" type="date" max={today} defaultValue={initial?.dob ?? ''} />
      </div>
      <div className={field}>
        <Label htmlFor="gender">{t('patient.gender')}</Label>
        <NativeSelect id="gender" name="gender" defaultValue={initial?.gender ?? ''}>
          <option value="">—</option>
          <option value="female">{t('gender.female')}</option>
          <option value="male">{t('gender.male')}</option>
          <option value="other">{t('gender.other')}</option>
        </NativeSelect>
      </div>
      <div className={field}>
        <Label htmlFor="language">{t('patient.language')}</Label>
        <NativeSelect id="language" name="language" defaultValue={initial?.language ?? 'en'}>
          <option value="en">{t('language.en')}</option>
          <option value="hi">{t('language.hi')}</option>
        </NativeSelect>
      </div>

      <GuardianPicker value={guardian} onChange={setGuardian} excludeId={initial?.id} />

      <div className={field}>
        <Label htmlFor="email">{t('patient.email')}</Label>
        <Input
          id="email"
          name="email"
          type="email"
          maxLength={254}
          defaultValue={initial?.email ?? ''}
        />
      </div>
      <div className={field}>
        <Label htmlFor="bloodGroup">{t('patient.bloodGroup')}</Label>
        <NativeSelect id="bloodGroup" name="bloodGroup" defaultValue={initial?.bloodGroup ?? ''}>
          <option value="">—</option>
          {BLOOD_GROUPS.map((g) => (
            <option key={g} value={g}>
              {g}
            </option>
          ))}
        </NativeSelect>
      </div>
      <div className={wideField}>
        <Label htmlFor="address">{t('patient.address')}</Label>
        <Input id="address" name="address" maxLength={300} defaultValue={initial?.address ?? ''} />
      </div>
      <div className={field}>
        <Label htmlFor="emergencyContactName">{t('patient.emergencyName')}</Label>
        <Input
          id="emergencyContactName"
          name="emergencyContactName"
          maxLength={120}
          defaultValue={initial?.emergencyContactName ?? ''}
        />
      </div>
      <div className={field}>
        <Label htmlFor="emergencyContactPhone">{t('patient.emergencyPhone')}</Label>
        <Input
          id="emergencyContactPhone"
          name="emergencyContactPhone"
          type="tel"
          maxLength={20}
          defaultValue={initial?.emergencyContactPhone ?? ''}
        />
      </div>

      {children}

      <div className={wideField}>
        <Button type="submit" disabled={busy} className="w-full sm:w-auto sm:justify-self-start">
          {submitLabel}
        </Button>
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
    <fieldset className="field wide guardian m-0 grid min-w-0 gap-3 rounded-xl border border-border p-4 pt-2 sm:col-span-2">
      <legend className="px-1 text-sm font-semibold">{t('patient.guardian')}</legend>
      <p className="hint text-sm text-muted-foreground">{t('patient.guardianHint')}</p>
      {value ? (
        <p
          data-testid="guardian-selected"
          className="flex flex-wrap items-center gap-x-2 gap-y-2 rounded-xl bg-accent px-3 py-2 text-accent-foreground"
        >
          <strong>{value.name}</strong> · <span className="tabular">{value.uhid}</span>{' '}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="ml-auto min-h-11"
            onClick={() => onChange(null)}
          >
            {t('patient.guardianRemove')}
          </Button>
        </p>
      ) : (
        <>
          <div className="search grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto]">
            <Label htmlFor="guardian-q" className="sr-only">
              {t('patient.guardianSearch')}
            </Label>
            <Input
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
            <Button type="button" variant="outline" onClick={() => void find()}>
              {t('patient.guardianSearch')}
            </Button>
          </div>
          {error && (
            <p className="alert rounded-xl bg-danger-soft px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}
          {results && results.length === 0 && (
            <p className="hint text-sm text-muted-foreground">{t('dashboard.noPatients')}</p>
          )}
          {results && results.length > 0 && (
            <ul className="pick-list m-0 grid list-none gap-2 p-0">
              {results.map((p) => (
                <li
                  key={p.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border px-3 py-2"
                >
                  <span className="min-w-0">
                    {p.name} · <span className="tabular">{p.uhid}</span>
                  </span>{' '}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="min-h-11"
                    onClick={() => {
                      onChange({ id: p.id, uhid: p.uhid, name: p.name });
                      setResults(null);
                      setQuery('');
                    }}
                  >
                    {t('patient.choose')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </fieldset>
  );
}
