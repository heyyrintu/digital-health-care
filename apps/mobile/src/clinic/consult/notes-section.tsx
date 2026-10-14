import {
  ConsultationNotes,
  ConsultationRecord,
  type ConsultationView,
  type Diagnosis,
} from '@dhc/contracts';
import { searchIcd10 } from '@dhc/domain';
import type { MessageKey } from '@dhc/i18n';
import { Button, Card, Notice, Text, TextField, useTheme } from '@dhc/ui-native';
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { ApiError } from '@dhc/api-client';
import { errorMessage } from '../../errors';
import { useLocale } from '../../locale/provider';
import { saveOrQueue } from '../actions';

const TEXT_FIELDS: { key: keyof ConsultationNotes; label: MessageKey; multiline?: boolean }[] = [
  { key: 'chiefComplaint', label: 'consult.chiefComplaint' },
  { key: 'examination', label: 'consult.examination', multiline: true },
  { key: 'plan', label: 'consult.plan', multiline: true },
  { key: 'testsAdvised', label: 'consult.testsAdvised', multiline: true },
  { key: 'advice', label: 'consult.advice', multiline: true },
  { key: 'privateNotes', label: 'consult.privateNotes', multiline: true },
];

/**
 * The visit's notes. Saved on demand; offline the save waits on the device and is sent
 * with the revision it started from, so newer notes from another device are never
 * overwritten (the server answers "stale" instead).
 */
export function NotesSection({
  view,
  onSaved,
}: {
  view: ConsultationView;
  onSaved: (record: ConsultationRecord) => void;
}) {
  const { t } = useLocale();
  const theme = useTheme();
  const editable = view.canEdit && !view.consultation?.lockedAt;
  const [notes, setNotes] = useState<ConsultationNotes>(
    () => view.consultation?.notes ?? ConsultationNotes.parse({}),
  );
  const [followUp, setFollowUp] = useState(view.consultation?.followUpDate ?? '');
  const [revision, setRevision] = useState(view.consultation?.revision ?? 0);
  const [dx, setDx] = useState('');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'error' | 'info' | 'success'; text: string } | null>(
    null,
  );

  const edit = (next: ConsultationNotes) => {
    setNotes(next);
    setDirty(true);
  };
  const addDiagnosis = (d: Diagnosis) => {
    if (notes.diagnoses.length >= 10) return;
    edit({ ...notes, diagnoses: [...notes.diagnoses, d] });
    setDx('');
  };

  async function save() {
    setBusy(true);
    setNotice(null);
    try {
      const result = await saveOrQueue({
        kind: 'notes',
        path: `/appointments/${view.appointment.id}/consultation`,
        body: {
          notes,
          followUpDate: /^\d{4}-\d{2}-\d{2}$/.test(followUp) ? followUp : null,
          revision,
        },
        label: `${t('consult.title')} · ${view.appointment.patient.name}`,
        schema: ConsultationRecord,
      });
      setDirty(false);
      if (result.status === 'saved') {
        setRevision(result.data.revision);
        onSaved(result.data);
        setNotice({ tone: 'success', text: t('rx.saved') });
      } else {
        setNotice({ tone: 'info', text: t('mobile.clinic.savedOnDevice') });
      }
    } catch (error) {
      const stale = error instanceof ApiError && error.fields.revision === 'stale';
      setNotice({ tone: 'error', text: stale ? t('consult.stale') : errorMessage(error, t) });
    } finally {
      setBusy(false);
    }
  }

  const suggestions = dx.trim().length >= 2 ? searchIcd10(dx, 5) : [];
  return (
    <Card>
      <Text variant="heading">{t('consult.title')}</Text>
      {!view.canEdit && <Notice>{t('consult.readOnly')}</Notice>}
      {view.consultation?.lockedAt && <Notice>{t('consult.locked')}</Notice>}
      {TEXT_FIELDS.map((f) => (
        <TextField
          key={f.key}
          label={t(f.label)}
          editable={editable}
          multiline={f.multiline}
          value={notes[f.key] as string}
          onChangeText={(value) => edit({ ...notes, [f.key]: value })}
        />
      ))}
      <Text variant="label">{t('consult.diagnosis')}</Text>
      {notes.diagnoses.map((d, i) => (
        <View
          key={`${d.code}-${d.label}-${i}`}
          style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing[2] }}
        >
          <Text style={{ flex: 1 }}>
            {d.code ? `${d.code} · ` : ''}
            {d.label}
          </Text>
          {editable && (
            <Button
              variant="ghost"
              label={t('consult.remove')}
              onPress={() =>
                edit({ ...notes, diagnoses: notes.diagnoses.filter((_, j) => j !== i) })
              }
            />
          )}
        </View>
      ))}
      {editable && (
        <>
          <TextField label={t('consult.diagnosisSearch')} value={dx} onChangeText={setDx} />
          {suggestions.map((s) => (
            <Pressable
              key={s.code}
              accessibilityRole="button"
              onPress={() => addDiagnosis({ code: s.code, label: s.label })}
              style={{ minHeight: theme.minTouchTarget, justifyContent: 'center' }}
            >
              <Text>
                {s.code} · {s.label}
              </Text>
            </Pressable>
          ))}
          {dx.trim().length >= 2 && (
            <Button
              variant="secondary"
              label={t('consult.addFreeText', { text: dx.trim() })}
              onPress={() => addDiagnosis({ code: null, label: dx.trim().slice(0, 200) })}
            />
          )}
        </>
      )}
      <TextField
        label={t('consult.followUp')}
        hint="YYYY-MM-DD"
        editable={editable}
        value={followUp}
        onChangeText={(v) => {
          setFollowUp(v);
          setDirty(true);
        }}
      />
      {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}
      {editable && (
        <Button
          label={dirty ? t('common.save') : t('rx.saved')}
          disabled={!dirty}
          loading={busy}
          onPress={() => void save()}
        />
      )}
    </Card>
  );
}
