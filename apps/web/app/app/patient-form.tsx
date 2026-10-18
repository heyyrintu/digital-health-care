'use client';

import type { Gender, PortalPatient } from '@dhc/contracts';
import { istDateKey } from '@dhc/domain';
import { Button, Field, Input } from '@dhc/ui-web';
import { useState, type FormEvent } from 'react';
import { patientDraftProblems, portalErrorMessage, type PatientDraft } from '../../lib/patient';
import { ChoiceGroup, Notice } from './parts';
import { usePatientSession } from './session-provider';

const GENDERS: Gender[] = ['female', 'male', 'other'];
const NO_GUARDIAN = 'none';

/** Name, date of birth and gender for a new record on the account (PRD §4.1). */
export function PatientForm({
  guardians = [],
  submitLabel,
  onSaved,
}: {
  /** Adults on the account who can look after a child; none offers no choice. */
  guardians?: PortalPatient[];
  submitLabel: string;
  onSaved: (patient: PortalPatient) => void | Promise<void>;
}) {
  const { api, locale, t } = usePatientSession();
  const today = istDateKey(new Date());
  const [draft, setDraft] = useState<PatientDraft>({
    name: '',
    dob: '',
    gender: null,
    guardianId: null,
  });
  const [problems, setProblems] = useState<ReturnType<typeof patientDraftProblems>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const change = (next: Partial<PatientDraft>) => setDraft((d) => ({ ...d, ...next }));

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const found = patientDraftProblems(draft, today);
    setProblems(found);
    setError(found.form ? t(found.form) : null);
    if (Object.keys(found).length > 0) return;
    setBusy(true);
    try {
      const created = await api.addPortalPatient({
        name: draft.name.trim(),
        dob: draft.dob.trim(),
        gender: draft.gender as Gender,
        language: locale,
        ...(draft.guardianId ? { guardianPatientId: draft.guardianId } : {}),
      });
      await onSaved(created);
    } catch (e) {
      setError(portalErrorMessage(e, t));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="space-y-4" onSubmit={(e) => void save(e)} noValidate>
      {error && <Notice tone="error">{error}</Notice>}
      <Field label={t('patient.profile.name')} error={problems.name ? t(problems.name) : undefined}>
        <Input
          name="name"
          value={draft.name}
          onChange={(e) => change({ name: e.target.value })}
          autoComplete="name"
          maxLength={120}
        />
      </Field>
      <Field label={t('patient.profile.dob')} error={problems.dob ? t(problems.dob) : undefined}>
        <Input
          name="dob"
          type="date"
          value={draft.dob}
          onChange={(e) => change({ dob: e.target.value })}
          max={today}
          autoComplete="bday"
        />
      </Field>
      <ChoiceGroup
        label={t('patient.gender')}
        options={GENDERS.map((g) => ({ value: g, label: t(`gender.${g}`) }))}
        value={draft.gender as Gender | null}
        onChange={(gender) => change({ gender })}
        error={problems.gender ? t(problems.gender) : undefined}
      />
      {guardians.length > 0 && (
        <ChoiceGroup
          label={t('patient.family.guardian')}
          options={[
            { value: NO_GUARDIAN, label: t('patient.family.guardianNone') },
            ...guardians.map((g) => ({ value: g.id, label: g.name })),
          ]}
          value={draft.guardianId ?? NO_GUARDIAN}
          onChange={(id) => {
            change({ guardianId: id === NO_GUARDIAN ? null : id });
            setError(null);
          }}
        />
      )}
      <Button type="submit" disabled={busy} className="w-full sm:w-auto">
        {submitLabel}
      </Button>
    </form>
  );
}
