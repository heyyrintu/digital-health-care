import { Vitals, VitalsBody, type ConsultationView } from '@dhc/contracts';
import { bmiOf } from '@dhc/domain';
import type { MessageKey } from '@dhc/i18n';
import { Button, Card, Notice, Text, TextField } from '@dhc/ui-native';
import { useState } from 'react';
import { errorMessage } from '../../errors';
import { useLocale } from '../../locale/provider';
import { saveOrQueue } from '../actions';

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

type Draft = Record<(typeof FIELDS)[number]['key'], string>;

/** Today's readings; like notes, a save without network waits on the device (ADR 0009). */
export function VitalsSection({ view }: { view: ConsultationView }) {
  const { t } = useLocale();
  const [draft, setDraft] = useState<Draft>(
    () =>
      Object.fromEntries(
        FIELDS.map((f) => [f.key, view.vitals?.[f.key] == null ? '' : String(view.vitals[f.key])]),
      ) as Draft,
  );
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'error' | 'info' | 'success'; text: string } | null>(
    null,
  );
  const num = (v: string) => (v.trim() === '' ? null : Number(v.replace(',', '.')));
  const bmi = bmiOf(num(draft.weightKg), num(draft.heightCm));

  async function save() {
    setNotice(null);
    const parsed = VitalsBody.safeParse(
      Object.fromEntries(FIELDS.map((f) => [f.key, num(draft[f.key])])),
    );
    if (!parsed.success) {
      setNotice({ tone: 'error', text: t('mobile.clinic.vitalsInvalid') });
      return;
    }
    setBusy(true);
    try {
      const result = await saveOrQueue({
        kind: 'vitals',
        path: `/appointments/${view.appointment.id}/vitals`,
        body: { ...parsed.data, pregnancyStatus: view.vitals?.pregnancyStatus ?? null },
        label: `${t('vitals.title')} · ${view.appointment.patient.name}`,
        schema: Vitals,
      });
      setNotice(
        result.status === 'saved'
          ? { tone: 'success', text: t('vitals.saved') }
          : { tone: 'info', text: t('mobile.clinic.savedOnDevice') },
      );
    } catch (error) {
      setNotice({ tone: 'error', text: errorMessage(error, t) });
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
          editable={view.canEdit}
          value={draft[f.key]}
          onChangeText={(v) => setDraft({ ...draft, [f.key]: v })}
        />
      ))}
      {bmi !== null && <Text variant="muted">{t('vitals.bmi', { bmi })}</Text>}
      {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}
      {view.canEdit && (
        <Button label={t('vitals.save')} loading={busy} onPress={() => void save()} />
      )}
    </Card>
  );
}
