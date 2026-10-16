import { Allergy, PatientChart } from '@dhc/contracts';
import { Button, Card, Notice, Text, TextField, useTheme } from '@dhc/ui-native';
import { useState } from 'react';
import { View } from 'react-native';
import { api } from '../../api';
import { errorMessage } from '../../errors';
import { useLocale } from '../../locale/provider';
import { newKey } from '../send';
import { isNetworkError } from '../today';

/**
 * The patient chart beside the consultation (PRD §6.1): allergies first and highlighted,
 * then conditions, current medicines and recent visits. Patient-reported entries are
 * labelled unverified. Doctors can add an allergy here (it feeds the safety checks);
 * removing entries and adding conditions or medicines stay on the web for now.
 */
export function ChartSection({
  chart,
  editable,
  onChange,
}: {
  chart: PatientChart;
  editable: boolean;
  onChange: (chart: PatientChart) => void;
}) {
  const { t } = useLocale();
  const theme = useTheme();
  const [adding, setAdding] = useState(false);
  const [substance, setSubstance] = useState('');
  const [reaction, setReaction] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // The last attempt lost its answer: it may have been saved, so look before posting again.
  const [unsure, setUnsure] = useState(false);
  const unverified = (source: string) =>
    source === 'patient' ? ` · ${t('chart.unverified')}` : '';

  async function addAllergy() {
    setBusy(true);
    setProblem(null);
    const done = () => {
      setAdding(false);
      setUnsure(false);
      setSubstance('');
      setReaction('');
    };
    try {
      let base = chart;
      if (unsure) {
        // The newest chart is the base either way, so changes made meanwhile are kept.
        base = await api.request('GET', `/patients/${chart.patientId}/chart`, {
          schema: PatientChart,
        });
        const name = substance.trim().toLowerCase();
        if (base.allergies.some((a) => a.substance.toLowerCase() === name)) {
          onChange(base);
          done();
          return;
        }
      }
      const allergy = await api.request('POST', `/patients/${chart.patientId}/allergies`, {
        schema: Allergy,
        body: { substance: substance.trim(), reaction: reaction.trim() || null, source: 'doctor' },
        idempotencyKey: newKey(),
      });
      onChange({ ...base, allergies: [...base.allergies, allergy] });
      done();
    } catch (error) {
      if (isNetworkError(error)) setUnsure(true);
      setProblem(
        isNetworkError(error) ? t('mobile.clinic.needsConnection') : errorMessage(error, t),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <Text variant="heading">{t('chart.title')}</Text>
      <Text variant="label">{t('chart.allergies')}</Text>
      {chart.allergies.length === 0 ? (
        <Text variant="muted">{t('chart.noAllergies')}</Text>
      ) : (
        chart.allergies.map((a) => (
          <Notice key={a.id} tone="error">
            {`${a.substance}${a.reaction ? ` · ${a.reaction}` : ''}${unverified(a.source)}`}
          </Notice>
        ))
      )}
      {editable && !adding && (
        <Button
          variant="secondary"
          label={`${t('chart.add')}: ${t('chart.allergies')}`}
          onPress={() => setAdding(true)}
        />
      )}
      {adding && (
        <View style={{ gap: theme.spacing[2] }}>
          <TextField
            label={t('chart.substance')}
            value={substance}
            // Held while an attempt may have been saved, so the check looks for what was sent.
            editable={!busy && !unsure}
            maxLength={120}
            onChangeText={setSubstance}
          />
          <TextField
            label={t('chart.reaction')}
            value={reaction}
            editable={!busy && !unsure}
            maxLength={200}
            onChangeText={setReaction}
          />
          {problem && <Notice tone="error">{problem}</Notice>}
          <Button
            label={t('chart.add')}
            disabled={substance.trim() === ''}
            loading={busy}
            onPress={() => void addAllergy()}
          />
          <Button
            variant="ghost"
            label={t('common.cancel')}
            disabled={busy}
            onPress={() => {
              setAdding(false);
              setUnsure(false);
              setSubstance('');
              setReaction('');
            }}
          />
        </View>
      )}
      <Text variant="label">{t('chart.conditions')}</Text>
      {chart.conditions.length === 0 ? (
        <Text variant="muted">{t('chart.none')}</Text>
      ) : (
        chart.conditions.map((c) => (
          <Text key={c.id}>
            {c.name}
            {c.icd10Code ? ` · ${c.icd10Code}` : ''}
            {unverified(c.source)}
          </Text>
        ))
      )}
      <Text variant="label">{t('chart.medications')}</Text>
      {chart.medications.length === 0 ? (
        <Text variant="muted">{t('chart.none')}</Text>
      ) : (
        chart.medications.map((m) => (
          <Text key={m.id}>
            {m.name}
            {m.dose ? ` · ${m.dose}` : ''}
            {unverified(m.source)}
          </Text>
        ))
      )}
      <Text variant="label">{t('chart.recentVisits')}</Text>
      {chart.recentVisits.length === 0 ? (
        <Text variant="muted">{t('chart.noVisits')}</Text>
      ) : (
        chart.recentVisits.map((v) => (
          <Text key={v.appointmentId} variant="muted">
            {v.date} · {v.doctorName ?? t('role.doctor')} · {v.chiefComplaint}
            {v.diagnoses.length > 0 ? ` · ${v.diagnoses.map((d) => d.label).join(', ')}` : ''}
          </Text>
        ))
      )}
    </Card>
  );
}
