import {
  ConsultationNotes,
  ConsultationRecord,
  type ConsultationView,
  type Diagnosis,
  type SaveConsultationBody,
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
import { waitingBody } from '../runtime';

/** `max` matches the ConsultationNotes contract, so a note never fails to save for length. */
const TEXT_FIELDS: {
  key: keyof ConsultationNotes;
  label: MessageKey;
  max: number;
  multiline?: boolean;
}[] = [
  { key: 'chiefComplaint', label: 'consult.chiefComplaint', max: 500 },
  { key: 'examination', label: 'consult.examination', max: 4000, multiline: true },
  { key: 'plan', label: 'consult.plan', max: 4000, multiline: true },
  { key: 'testsAdvised', label: 'consult.testsAdvised', max: 2000, multiline: true },
  { key: 'advice', label: 'consult.advice', max: 4000, multiline: true },
  { key: 'privateNotes', label: 'consult.privateNotes', max: 4000, multiline: true },
];

/** A blank follow-up clears it; anything else must be a real YYYY-MM-DD date. */
export function followUpValue(input: string): string | null | undefined {
  const v = input.trim();
  if (!v) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return undefined;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(v) ? v : undefined;
}

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
  // A save still waiting on this device is newer than the copy the visit was opened with.
  const [waiting] = useState(() =>
    waitingBody<SaveConsultationBody>('notes', `/appointments/${view.appointment.id}/consultation`),
  );
  const [notes, setNotes] = useState<ConsultationNotes>(
    () => waiting?.notes ?? view.consultation?.notes ?? ConsultationNotes.parse({}),
  );
  const [followUp, setFollowUp] = useState(
    (waiting ? waiting.followUpDate : view.consultation?.followUpDate) ?? '',
  );
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

  // Edits wait while a save is in flight: its answer replaces the draft.
  const canType = editable && !busy;

  async function save() {
    const followUpDate = followUpValue(followUp);
    if (followUpDate === undefined) {
      setNotice({ tone: 'error', text: t('mobile.clinic.followUpInvalid') });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const result = await saveOrQueue({
        kind: 'notes',
        path: `/appointments/${view.appointment.id}/consultation`,
        body: {
          notes,
          followUpDate,
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
          editable={canType}
          maxLength={f.max}
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
              disabled={busy}
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
          <TextField
            label={t('consult.diagnosisSearch')}
            editable={canType}
            maxLength={200}
            value={dx}
            onChangeText={setDx}
          />
          {suggestions.map((s) => (
            <Pressable
              key={s.code}
              accessibilityRole="button"
              disabled={busy}
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
              disabled={busy}
              label={t('consult.addFreeText', { text: dx.trim() })}
              onPress={() => addDiagnosis({ code: null, label: dx.trim().slice(0, 200) })}
            />
          )}
        </>
      )}
      <TextField
        label={t('consult.followUp')}
        hint="YYYY-MM-DD"
        editable={canType}
        maxLength={10}
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
