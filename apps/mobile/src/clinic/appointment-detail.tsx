import type { Appointment, MeResponse } from '@dhc/contracts';
import { appointmentActions, type QueueAction } from '@dhc/domain';
import type { MessageKey } from '@dhc/i18n';
import { Button, Card, Notice, Text, useTheme } from '@dhc/ui-native';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { errorMessage } from '../errors';
import { useLocale } from '../locale/provider';
import { canConsult, runAction } from './actions';

/**
 * One appointment with the actions this person may take. Cancelling (which needs a reason)
 * and rescheduling stay on the web for now.
 */
export function AppointmentDetailPane({
  a,
  me,
  today,
  pendingCheckIn,
  onChanged,
}: {
  a: Appointment;
  me: MeResponse;
  today: string;
  pendingCheckIn: boolean;
  onChanged: () => Promise<void>;
}) {
  const { t } = useLocale();
  const theme = useTheme();
  const router = useRouter();
  const [busy, setBusy] = useState<QueueAction | null>(null);
  const [notice, setNotice] = useState<{ tone: 'error' | 'info'; text: string } | null>(null);
  const actions = pendingCheckIn
    ? []
    : appointmentActions(a, { role: me.role, userId: me.user.id }, today, new Date()).filter(
        (action) => action !== 'cancel',
      );

  async function act(action: QueueAction) {
    setBusy(action);
    setNotice(null);
    try {
      const result = await runAction(a, action);
      if (result === 'queued') setNotice({ tone: 'info', text: t('mobile.clinic.checkInQueued') });
      if (result === 'needs_connection') {
        setNotice({ tone: 'error', text: t('mobile.clinic.needsConnection') });
      }
      await onChanged();
    } catch (error) {
      setNotice({ tone: 'error', text: errorMessage(error, t) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <Text variant="heading">
        {t('queue.token', { token: a.tokenNumber })} · {a.patient.name}
      </Text>
      <Text variant="muted">
        {a.patient.uhid}
        {a.patient.phone ? ` · ${a.patient.phone}` : ''}
      </Text>
      <Text>
        {a.source === 'walk_in' ? t('appointments.walkInBadge') : a.startTime} ·{' '}
        {a.doctorName ?? t('role.doctor')} · {a.consultationTypeName} ·{' '}
        {t(`mode.${a.mode}` as MessageKey)}
      </Text>
      <Text variant="label">{t(`status.${a.status}` as MessageKey)}</Text>
      {a.reason && <Text variant="muted">{t('mobile.clinic.reason', { reason: a.reason })}</Text>}
      {a.patient.tags.length > 0 && (
        <Text variant="muted">{a.patient.tags.map((tag) => tag.name).join(' · ')}</Text>
      )}
      {pendingCheckIn && <Notice>{t('mobile.clinic.pendingCheckIn')}</Notice>}
      {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing[2] }}>
        {actions.map((action) => (
          <Button
            key={action}
            variant={action === 'no_show' ? 'secondary' : 'primary'}
            label={t(`action.${action}` as MessageKey)}
            loading={busy === action}
            disabled={busy !== null}
            onPress={() => void act(action)}
          />
        ))}
        {canConsult(a, me.role) && (
          <Button
            variant="secondary"
            label={t('action.consult')}
            onPress={() => router.push(`/consultation/${a.id}`)}
          />
        )}
      </View>
    </Card>
  );
}
