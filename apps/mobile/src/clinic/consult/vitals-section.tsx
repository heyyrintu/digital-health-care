import { ApiError } from '@dhc/api-client';
import { Vitals, VitalsBody, type ConsultationView, type PregnancyStatus } from '@dhc/contracts';
import { ageFrom, bmiOf, istDateKey } from '@dhc/domain';
import type { MessageKey } from '@dhc/i18n';
import { Button, Card, Notice, Text, TextField, useTheme } from '@dhc/ui-native';
import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { errorMessage } from '../../errors';
import { useLocale } from '../../locale/provider';
import { saveOrQueue } from '../actions';
import { waitingBody } from '../runtime';

const FIELDS: { key: keyof VitalsBody & keyof Vitals; label: MessageKey; decimal?: boolean }[] = [
  { key: 'bpSystolic', label: 'vitals.systolic' },
  { key: 'bpDiastolic', label: 'vitals.diastolic' },
  { key: 'pulse', label: 'vitals.pulse' },
  { key: 'temperatureC', label: 'vitals.temperature', decimal: true },
  { key: 'spo2', label: 'vitals.spo2' },
  { key: 'weightKg', label: 'vitals.weight', decimal: true },
  { key: 'heightCm', label: 'vitals.height', decimal: true },
  { key: 'painScore', label: 'vitals.pain' },
];

const PREGNANCY: PregnancyStatus[] = ['not_pregnant', 'pregnant', 'breastfeeding'];

type Draft = Record<(typeof FIELDS)[number]['key'], string>;

/**
 * Today's readings; like notes, a save without network waits on the device (ADR 0009). Each
 * save says which readings it started from, so a replay never replaces readings recorded
 * elsewhere meanwhile (the server answers "stale" instead).
 */
export function VitalsSection({
  view,
  onSaved,
  onDirty,
}: {
  view: ConsultationView;
  onSaved: (vitals: Vitals) => void;
  onDirty: (dirty: boolean) => void;
}) {
  const { t } = useLocale();
  const theme = useTheme();
  // A save still waiting on this device is newer than the copy the visit was opened with.
  const [waiting] = useState(() =>
    waitingBody<VitalsBody>('vitals', `/appointments/${view.appointment.id}/vitals`),
  );
  const shown = waiting ?? view.vitals;
  const [draft, setDraft] = useState<Draft>(
    () =>
      Object.fromEntries(
        FIELDS.map((f) => [f.key, shown?.[f.key] == null ? '' : String(shown[f.key])]),
      ) as Draft,
  );
  const [pregnancy, setPregnancy] = useState<PregnancyStatus | null>(
    shown?.pregnancyStatus ?? null,
  );
  const [basedOn, setBasedOn] = useState<string | null>(
    waiting ? (waiting.basedOn ?? null) : (view.vitals?.updatedAt ?? null),
  );
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  // Reported to the screen, which holds a reload back while any section has unsaved edits.
  const onDirtyRef = useRef(onDirty);
  onDirtyRef.current = onDirty;
  useEffect(() => onDirtyRef.current(dirty), [dirty]);
  useEffect(() => () => onDirtyRef.current(false), []);
  const [notice, setNotice] = useState<{ tone: 'error' | 'info' | 'success'; text: string } | null>(
    null,
  );
  const num = (v: string) => (v.trim() === '' ? null : Number(v.replace(',', '.')));
  const bmi = bmiOf(num(draft.weightKg), num(draft.heightCm));
  const { dob, gender } = view.appointment.patient;
  const ageYears = dob ? ageFrom(dob, istDateKey(new Date())).years : null;
  // As on the web: asked for women and girls from 12, since it changes the safety checks.
  const asksPregnancy = gender === 'female' && (ageYears === null || ageYears >= 12);
  // Edits wait while a save is in flight, so the screen never shows readings it did not save.
  const canType = view.canEdit && !busy;

  async function save() {
    setNotice(null);
    const parsed = VitalsBody.safeParse({
      ...Object.fromEntries(FIELDS.map((f) => [f.key, num(draft[f.key])])),
      pregnancyStatus: pregnancy,
      basedOn,
    });
    if (!parsed.success) {
      setNotice({ tone: 'error', text: t('mobile.clinic.vitalsInvalid') });
      return;
    }
    setBusy(true);
    try {
      const result = await saveOrQueue({
        kind: 'vitals',
        path: `/appointments/${view.appointment.id}/vitals`,
        body: parsed.data,
        label: `${t('vitals.title')} · ${view.appointment.patient.name}`,
        schema: Vitals,
      });
      setDirty(false);
      if (result.status === 'saved') {
        setBasedOn(result.data.updatedAt);
        onSaved(result.data);
        setNotice({ tone: 'success', text: t('vitals.saved') });
      } else {
        setNotice({ tone: 'info', text: t('mobile.clinic.savedOnDevice') });
      }
    } catch (error) {
      const stale = error instanceof ApiError && error.fields.basedOn === 'stale';
      setNotice({
        tone: 'error',
        text: stale ? t('mobile.clinic.vitalsStale') : errorMessage(error, t),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <Text variant="heading">{t('vitals.title')}</Text>
      {FIELDS.map((f) => (
        <TextField
          key={f.key}
          label={t(f.label)}
          keyboardType={f.decimal ? 'decimal-pad' : 'number-pad'}
          editable={canType}
          maxLength={6}
          value={draft[f.key]}
          onChangeText={(v) => {
            setDraft({ ...draft, [f.key]: v });
            setDirty(true);
          }}
        />
      ))}
      {bmi !== null && <Text variant="muted">{t('vitals.bmi', { bmi })}</Text>}
      {asksPregnancy && (
        <>
          <Text variant="label">{t('vitals.pregnancy')}</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing[2] }}>
            {[null, ...PREGNANCY].map((p) => (
              <Button
                key={p ?? 'none'}
                variant={pregnancy === p ? 'primary' : 'secondary'}
                label={t(p ? `vitals.pregnancy.${p}` : 'vitals.pregnancy.none')}
                accessibilityState={{ selected: pregnancy === p }}
                disabled={!canType}
                onPress={() => {
                  setPregnancy(p);
                  setDirty(true);
                }}
              />
            ))}
          </View>
        </>
      )}
      {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}
      {view.canEdit && (
        <Button label={t('vitals.save')} loading={busy} onPress={() => void save()} />
      )}
    </Card>
  );
}
