import { ApiError } from '@dhc/api-client';
import {
  LastPrescription,
  MedicineList,
  Prescription,
  SafetySummary,
  type ConsultationView,
  type DurationUnit,
  type Language,
  type Medicine,
  type PrescriptionView,
  type SafetyAlert,
} from '@dhc/contracts';
import { alertText, type MessageKey } from '@dhc/i18n';
import { Button, Card, CodeField, Notice, Text, TextField, useTheme } from '@dhc/ui-native';
import * as LocalAuthentication from 'expo-local-authentication';
import { useEffect, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import { api } from '../../api';
import { errorMessage, isSixDigitCode } from '../../errors';
import { useLocale } from '../../locale/provider';
import { useToday } from '../hooks';
import { medicines } from '../runtime';
import { newKey } from '../send';
import { isNetworkError } from '../today';
import {
  appendLines,
  freeTextLine,
  lineFromItem,
  lineFromMedicine,
  previewRemarks,
  signBlocker,
  toSaveBody,
  type DraftLine,
} from './rx-draft';

const UNITS: DurationUnit[] = ['days', 'weeks', 'months'];
type Tone = 'error' | 'info' | 'success' | 'warning';

/**
 * The prescription on the Clinic app (PRD §6.4–6.6): search the medicine list (the device
 * copy when offline), edit the lines, save (the server runs the safety checks), answer
 * the alerts, then sign with biometrics and the signing PIN. Saving and signing need a
 * connection; the lines stay on screen until then.
 */
export function PrescriptionSection({
  view,
  rx,
  onChanged,
}: {
  view: ConsultationView;
  rx: PrescriptionView;
  onChanged: () => Promise<void>;
}) {
  const { t } = useLocale();
  const theme = useTheme();
  const appointmentId = view.appointment.id;
  const [lines, setLines] = useState<DraftLine[]>(() =>
    (rx.prescription?.items ?? []).map(lineFromItem),
  );
  const [language, setLanguage] = useState<Language>(
    rx.prescription?.language ?? rx.defaultLanguage,
  );
  const [saved, setSaved] = useState<Prescription | null>(rx.prescription);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: Tone; text: string } | null>(null);
  const editable = rx.canEdit;
  const templates = useToday().data?.templates ?? [];
  const [showTemplates, setShowTemplates] = useState(false);

  const add = (items: Parameters<typeof appendLines>[1], done: (count: number) => string) => {
    const result = appendLines(lines, items, newKey);
    change(result.lines);
    setNotice(
      result.added < items.length
        ? { tone: 'warning', text: t('rx.tooMany', { max: 30 }) }
        : { tone: 'info', text: done(result.added) },
    );
  };

  async function repeatLast() {
    setBusy('last');
    setNotice(null);
    try {
      const { last } = await api.request(
        'GET',
        `/patients/${view.appointment.patient.id}/last-prescription`,
        { schema: LastPrescription, query: { before: appointmentId } },
      );
      if (!last) setNotice({ tone: 'info', text: t('rx.noLast') });
      else add(last.items, (count) => t('rx.repeated', { date: last.date, count }));
    } catch (error) {
      setNotice({
        tone: 'error',
        text: isNetworkError(error) ? t('mobile.clinic.needsConnection') : errorMessage(error, t),
      });
    } finally {
      setBusy(null);
    }
  }

  const change = (next: DraftLine[]) => {
    setLines(next);
    setDirty(true);
  };

  async function save() {
    setBusy('save');
    setNotice(null);
    try {
      const result = await api.request('PUT', `/appointments/${appointmentId}/prescription`, {
        schema: Prescription,
        body: toSaveBody(lines, language, saved?.revision ?? 0),
        idempotencyKey: newKey(),
      });
      setSaved(result);
      setLines(result.items.map(lineFromItem));
      setDirty(false);
      setNotice({ tone: 'success', text: t('rx.saved') });
    } catch (error) {
      if (isNetworkError(error))
        setNotice({ tone: 'error', text: t('mobile.clinic.needsConnection') });
      else if (error instanceof ApiError && error.fields.revision === 'stale') {
        setNotice({ tone: 'error', text: t('rx.stale') });
      } else setNotice({ tone: 'error', text: errorMessage(error, t) });
    } finally {
      setBusy(null);
    }
  }

  async function answer(alert: SafetyAlert, action: 'acknowledge' | 'override', reason: string) {
    setBusy(alert.key);
    setNotice(null);
    try {
      const safety = await api.request(
        'POST',
        `/appointments/${appointmentId}/prescription/safety-actions`,
        { schema: SafetySummary, body: { key: alert.key, action, reason: reason.trim() || null } },
      );
      setSaved((p) => (p ? { ...p, safety } : p));
    } catch (error) {
      setNotice({ tone: 'error', text: errorMessage(error, t) });
    } finally {
      setBusy(null);
    }
  }

  const safety = saved?.safety ?? null;
  const blocker = signBlocker({
    dirty,
    lines: lines.length,
    openBlocks: safety?.openBlocks ?? 0,
    openWarnings: safety?.openWarnings ?? 0,
    missing: rx.signingMissing,
  });

  return (
    <Card>
      <Text variant="heading">{t('rx.title')}</Text>
      {!editable && !rx.canAmend && <Notice>{t('rx.readOnly')}</Notice>}
      {saved?.status === 'signed' && (
        <Notice tone="success">
          {t('sign.number', { number: saved.number ?? '', version: saved.version })}
        </Notice>
      )}
      {editable && (
        <View style={{ flexDirection: 'row', gap: theme.spacing[2], alignItems: 'center' }}>
          <Text variant="label">{t('rx.language')}</Text>
          {(['en', 'hi'] as const).map((l) => (
            <Button
              key={l}
              variant={language === l ? 'primary' : 'secondary'}
              label={l === 'en' ? 'English' : 'हिन्दी'}
              onPress={() => {
                setLanguage(l);
                setDirty(true);
              }}
            />
          ))}
        </View>
      )}
      {lines.length === 0 && <Text variant="muted">{t('rx.empty')}</Text>}
      {lines.map((line, i) => (
        <LineEditor
          key={line.id}
          line={line}
          language={language}
          editable={editable}
          alerts={(safety?.alerts ?? []).filter((a) => a.itemId === line.id)}
          onChange={(next) => change(lines.map((l, j) => (j === i ? next : l)))}
          onRemove={() => change(lines.filter((_, j) => j !== i))}
        />
      ))}
      {editable && lines.length < 30 && (
        <MedicineSearch onPick={(line) => change([...lines, line])} />
      )}
      {editable && (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing[2] }}>
          <Button
            variant="secondary"
            label={t('rx.repeatLast')}
            loading={busy === 'last'}
            onPress={() => void repeatLast()}
          />
          {templates.length > 0 && (
            <Button
              variant="secondary"
              label={t('rx.templates')}
              onPress={() => setShowTemplates((v) => !v)}
            />
          )}
        </View>
      )}
      {editable &&
        showTemplates &&
        templates.map((tpl) => (
          <Button
            key={tpl.id}
            variant="ghost"
            label={`${t('rx.applyTemplate')}: ${tpl.name}`}
            onPress={() => {
              setShowTemplates(false);
              add(tpl.items, (count) =>
                t('mobile.clinic.templateApplied', { name: tpl.name, count }),
              );
            }}
          />
        ))}
      {editable && (
        <Button
          label={dirty ? t('common.save') : t('rx.saved')}
          disabled={!dirty || lines.length === 0}
          loading={busy === 'save'}
          onPress={() => void save()}
        />
      )}
      {safety && (
        <SafetyList
          safety={safety}
          busyKey={busy}
          editable={editable}
          onAnswer={(alert, action, reason) => void answer(alert, action, reason)}
        />
      )}
      {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}
      {editable && saved && (
        <SignPanel
          appointmentId={appointmentId}
          revision={saved.revision}
          blocker={blocker}
          missing={rx.signingMissing}
          onSigned={onChanged}
        />
      )}
    </Card>
  );
}

function LineEditor({
  line,
  language,
  editable,
  alerts,
  onChange,
  onRemove,
}: {
  line: DraftLine;
  language: Language;
  editable: boolean;
  alerts: SafetyAlert[];
  onChange: (line: DraftLine) => void;
  onRemove: () => void;
}) {
  const { t } = useLocale();
  const theme = useTheme();
  return (
    <View
      style={{
        gap: theme.spacing[2],
        padding: theme.spacing[3],
        borderRadius: theme.radii.lg,
        borderWidth: 1,
        borderColor: alerts.some((a) => a.severity === 'block')
          ? theme.colors.destructive
          : theme.colors.border,
      }}
    >
      <Text variant="label">{line.name}</Text>
      {line.medicineId === null && <Text variant="caption">{t('rx.notInMaster')}</Text>}
      <View style={{ flexDirection: 'row', gap: theme.spacing[2] }}>
        <View style={{ flex: 1 }}>
          <TextField
            label={t('rx.dose')}
            editable={editable}
            value={line.dose}
            onChangeText={(dose) => onChange({ ...line, dose })}
          />
        </View>
        <View style={{ flex: 1 }}>
          <TextField
            label={t('rx.frequency')}
            hint={t('rx.frequencyHint')}
            editable={editable}
            value={line.frequency}
            onChangeText={(frequency) => onChange({ ...line, frequency })}
          />
        </View>
      </View>
      <View style={{ flexDirection: 'row', gap: theme.spacing[2], alignItems: 'flex-end' }}>
        <View style={{ width: 96 }}>
          <TextField
            label={t('rx.duration')}
            keyboardType="number-pad"
            editable={editable}
            value={line.durationValue === null ? '' : String(line.durationValue)}
            onChangeText={(v) => {
              const n = Number.parseInt(v, 10);
              onChange({
                ...line,
                durationValue: Number.isFinite(n) && n > 0 ? Math.min(n, 365) : null,
              });
            }}
          />
        </View>
        {UNITS.map((u) => (
          <Button
            key={u}
            variant={line.durationUnit === u ? 'primary' : 'secondary'}
            label={t(`rx.unit.${u}` as MessageKey)}
            disabled={!editable}
            onPress={() => onChange({ ...line, durationUnit: u })}
          />
        ))}
      </View>
      <TextField
        label={t('rx.instructions')}
        editable={editable}
        value={line.instructions}
        onChangeText={(instructions) => onChange({ ...line, instructions })}
      />
      <Text variant="muted">
        {t('rx.remarks')}: {previewRemarks(line, language)}
      </Text>
      {editable && (
        <Button
          variant="ghost"
          label={t('rx.removeLine', { name: line.name })}
          onPress={onRemove}
        />
      )}
    </View>
  );
}

function MedicineSearch({ onPick }: { onPick: (line: DraftLine) => void }) {
  const { t } = useLocale();
  const theme = useTheme();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Medicine[]>([]);
  const [offline, setOffline] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    const query = q.trim();
    const mine = ++seq.current;
    if (query.length < 2) {
      setResults([]);
      return;
    }
    const timer = setTimeout(() => {
      api
        .request('GET', '/medicines', { schema: MedicineList, query: { q: query } })
        .then((list) => {
          if (mine !== seq.current) return;
          setOffline(false);
          setResults(list.data);
        })
        .catch((error: unknown) => {
          if (mine !== seq.current || !isNetworkError(error)) return;
          // No network: search the copy kept on the device.
          setOffline(true);
          setResults(medicines.search(query));
        });
    }, 250);
    return () => clearTimeout(timer);
  }, [q]);

  const pick = (line: DraftLine) => {
    onPick(line);
    setQ('');
    setResults([]);
  };
  return (
    <View style={{ gap: theme.spacing[2] }}>
      <TextField label={t('rx.search')} value={q} onChangeText={setQ} autoCorrect={false} />
      {offline && <Text variant="caption">{t('mobile.clinic.offlineMedicines')}</Text>}
      {results.map((m) => (
        <Pressable
          key={m.id}
          accessibilityRole="button"
          onPress={() => pick(lineFromMedicine(newKey(), m))}
          style={{ minHeight: theme.minTouchTarget, justifyContent: 'center' }}
        >
          <Text>{m.name}</Text>
          <Text variant="caption">{m.composition}</Text>
        </Pressable>
      ))}
      {q.trim().length >= 2 && results.length === 0 && (
        <Text variant="muted">{t('rx.noMatches')}</Text>
      )}
      {q.trim().length >= 2 && (
        <Button
          variant="secondary"
          label={t('rx.addFreeText', { text: q.trim() })}
          onPress={() => pick(freeTextLine(newKey(), q.trim().slice(0, 200)))}
        />
      )}
    </View>
  );
}

function SafetyList({
  safety,
  busyKey,
  editable,
  onAnswer,
}: {
  safety: SafetySummary;
  busyKey: string | null;
  editable: boolean;
  onAnswer: (alert: SafetyAlert, action: 'acknowledge' | 'override', reason: string) => void;
}) {
  const { t } = useLocale();
  if (safety.alerts.length === 0) return <Notice tone="success">{t('safety.clear')}</Notice>;
  return (
    <View style={{ gap: 8 }}>
      <Text variant="label">{t('safety.title')}</Text>
      {safety.alerts.map((alert) => (
        <AlertRow
          key={alert.key}
          alert={alert}
          busy={busyKey === alert.key}
          editable={editable}
          onAnswer={onAnswer}
        />
      ))}
      <Text variant="caption">{t('safety.version', { version: safety.drugDatabaseVersion })}</Text>
    </View>
  );
}

function AlertRow({
  alert,
  busy,
  editable,
  onAnswer,
}: {
  alert: SafetyAlert;
  busy: boolean;
  editable: boolean;
  onAnswer: (alert: SafetyAlert, action: 'acknowledge' | 'override', reason: string) => void;
}) {
  const { t } = useLocale();
  const [reason, setReason] = useState('');
  const tone: Tone =
    alert.severity === 'block' ? 'error' : alert.severity === 'warn' ? 'warning' : 'info';
  const open = alert.action === null && alert.severity !== 'info';
  const action = alert.severity === 'block' ? 'override' : 'acknowledge';
  const needsReason = action === 'override' || alert.reasonRequired;
  return (
    <View style={{ gap: 6 }}>
      <Notice tone={tone}>
        {`${t(`safety.severity.${alert.severity}` as MessageKey)}: ${alertText(alert, t)}${
          alert.unverified ? ` (${t('safety.unverified')})` : ''
        }${alert.action ? ` · ${t(`safety.${alert.action}` as MessageKey)}` : ''}`}
      </Notice>
      {open && editable && alert.severity === 'block' && !alert.overridable && (
        <Text variant="muted">{t('safety.mustChange')}</Text>
      )}
      {open && editable && (alert.severity === 'warn' || alert.overridable) && (
        <>
          {needsReason && (
            <TextField label={t('safety.reason')} value={reason} onChangeText={setReason} />
          )}
          <Button
            variant={action === 'override' ? 'destructive' : 'secondary'}
            label={t(action === 'override' ? 'safety.override' : 'safety.acknowledge')}
            disabled={needsReason && reason.trim() === ''}
            loading={busy}
            onPress={() => onAnswer(alert, action, reason)}
          />
        </>
      )}
    </View>
  );
}

/**
 * Signing on the phone (build plan D8): the device owner's biometrics first, then the
 * signing PIN, which the server checks. The PIN is never stored on the device.
 */
function SignPanel({
  appointmentId,
  revision,
  blocker,
  missing,
  onSigned,
}: {
  appointmentId: string;
  revision: number;
  blocker: ReturnType<typeof signBlocker>;
  missing: PrescriptionView['signingMissing'];
  onSigned: () => Promise<void>;
}) {
  const { t } = useLocale();
  const [stage, setStage] = useState<'idle' | 'pin'>('idle');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function approve() {
    setProblem(null);
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: t('mobile.clinic.signPrompt'),
      disableDeviceFallback: false,
    });
    if (result.success) setStage('pin');
    else if (result.error !== 'user_cancel' && result.error !== 'system_cancel') {
      setProblem(t('mobile.clinic.unlockFailed'));
    }
  }

  async function sign() {
    setBusy(true);
    setProblem(null);
    try {
      await api.request('POST', `/appointments/${appointmentId}/prescription/sign`, {
        schema: Prescription,
        body: { revision, pin },
      });
      setStage('idle');
      setPin('');
      await onSigned();
    } catch (error) {
      setPin('');
      setProblem(
        isNetworkError(error) ? t('mobile.clinic.needsConnection') : errorMessage(error, t),
      );
    } finally {
      setBusy(false);
    }
  }

  const blockedText: Record<NonNullable<typeof blocker>, string> = {
    unsaved: t('sign.blocked.saving'),
    empty: t('sign.blocked.empty'),
    blocks: t('sign.blocked.safety'),
    warnings: t('sign.blocked.safety'),
    setup: missing.map((m) => t(`sign.missing.${m}` as MessageKey)).join(' '),
  };
  return (
    <View style={{ gap: 8 }}>
      {blocker && <Notice tone="warning">{blockedText[blocker]}</Notice>}
      {stage === 'idle' ? (
        <Button
          label={t('sign.start')}
          disabled={blocker !== null}
          onPress={() => void approve()}
        />
      ) : (
        <>
          <CodeField
            label={t('sign.pin')}
            hint={t('sign.pinHint')}
            secureTextEntry
            value={pin}
            onChangeText={setPin}
          />
          <Button
            label={t('sign.confirm')}
            disabled={!isSixDigitCode(pin)}
            loading={busy}
            onPress={() => void sign()}
          />
        </>
      )}
      {problem && <Notice tone="error">{problem}</Notice>}
    </View>
  );
}
