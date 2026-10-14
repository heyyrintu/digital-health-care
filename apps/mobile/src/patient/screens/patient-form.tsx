import type { Gender, PortalPatient } from '@dhc/contracts';
import { Button, Choice, Notice, TextField } from '@dhc/ui-native';
import { useState } from 'react';
import { api } from '../../api';
import { errorMessage } from '../../errors';
import { useLocale } from '../../locale/provider';
import { ChoiceRow } from '../parts';
import { isAdult, istToday, isValidDob } from '../logic';

const GENDERS: Gender[] = ['female', 'male', 'other'];

/** Name, date of birth and gender for a new record on the account. */
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
  const { t, locale } = useLocale();
  const [name, setName] = useState('');
  const [dob, setDob] = useState('');
  const [gender, setGender] = useState<Gender | null>(null);
  const [guardianId, setGuardianId] = useState<string | null>(null);
  const [errors, setErrors] = useState<{ name?: string; dob?: string }>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const next = {
      name: name.trim() ? undefined : t('patient.profile.nameRequired'),
      dob: isValidDob(dob.trim(), istToday(new Date()))
        ? undefined
        : t('patient.profile.dobInvalid'),
    };
    setErrors(next);
    if (next.name || next.dob || !gender) return;
    if (!guardianId && !isAdult(dob.trim(), istToday(new Date()))) {
      setError(t('patient.family.childNeedsGuardian'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await api.addPortalPatient({
        name: name.trim(),
        dob: dob.trim(),
        gender,
        language: locale,
        ...(guardianId ? { guardianPatientId: guardianId } : {}),
      });
      await onSaved(created);
    } catch (e) {
      setError(errorMessage(e, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {error && <Notice tone="error">{error}</Notice>}
      <TextField
        label={t('patient.profile.name')}
        value={name}
        onChangeText={setName}
        autoComplete="name"
        textContentType="name"
        error={errors.name}
      />
      <TextField
        label={t('patient.profile.dob')}
        hint={t('patient.profile.dobHint')}
        value={dob}
        onChangeText={setDob}
        keyboardType="numbers-and-punctuation"
        placeholder="1990-04-25"
        maxLength={10}
        error={errors.dob}
      />
      <ChoiceRow label={t('patient.gender')}>
        {GENDERS.map((g) => (
          <Choice
            key={g}
            label={t(`gender.${g}`)}
            selected={gender === g}
            onPress={() => setGender(g)}
          />
        ))}
      </ChoiceRow>
      {guardians.length > 0 && (
        <ChoiceRow label={t('patient.family.guardian')}>
          <Choice
            label={t('patient.family.guardianNone')}
            selected={guardianId === null}
            onPress={() => setGuardianId(null)}
          />
          {guardians.map((g) => (
            <Choice
              key={g.id}
              label={g.name}
              selected={guardianId === g.id}
              onPress={() => setGuardianId(g.id)}
            />
          ))}
        </ChoiceRow>
      )}
      <Button label={submitLabel} loading={busy} disabled={!gender} onPress={save} />
    </>
  );
}
