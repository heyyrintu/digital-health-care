import type { PortalAppointment } from '@dhc/contracts';
import { Button, Card, Notice, Text, useTheme } from '@dhc/ui-native';
import { useState } from 'react';
import { Alert, View } from 'react-native';
import { api } from '../../api';
import { errorMessage } from '../../errors';
import { useLocale } from '../../locale/provider';
import { useLoad } from '../../use-load';
import { shortDate } from '../logic';
import { LoadError, Loading, PatientScreen } from '../parts';

/** PRD §4.4: the family's upcoming and past appointments; cancel within the clinic's rules. */
export function AppointmentsScreen() {
  const { t } = useLocale();
  const { state, reload } = useLoad(() => api.portalAppointments(), []);
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);

  const cancel = (appointment: PortalAppointment) =>
    Alert.alert(t('patient.appts.cancelConfirm'), undefined, [
      { text: t('patient.appts.keep'), style: 'cancel' },
      {
        text: t('patient.appts.cancel'),
        style: 'destructive',
        onPress: async () => {
          try {
            await api.cancelPortalAppointment(appointment.id);
            setNotice({ tone: 'success', text: t('patient.appts.cancelled') });
          } catch (e) {
            setNotice({ tone: 'error', text: errorMessage(e, t) });
          }
          await reload();
        },
      },
    ]);

  return (
    <PatientScreen title={t('patient.nav.appointments')}>
      {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}
      {state.status === 'loading' && <Loading />}
      {state.status === 'error' && <LoadError error={state.error} retry={reload} />}
      {state.status === 'ready' && (
        <>
          <Text variant="heading">{t('patient.appts.upcoming')}</Text>
          <List items={state.data.upcoming} onCancel={cancel} />
          <Text variant="heading">{t('patient.appts.past')}</Text>
          <List items={state.data.past} />
        </>
      )}
    </PatientScreen>
  );
}

function List({
  items,
  onCancel,
}: {
  items: PortalAppointment[];
  onCancel?: (a: PortalAppointment) => void;
}) {
  const { t, locale } = useLocale();
  const theme = useTheme();
  if (items.length === 0) return <Text variant="muted">{t('patient.appts.none')}</Text>;
  return (
    <View style={{ gap: theme.spacing[3] }}>
      {items.map((a) => (
        <Card key={a.id}>
          <Text variant="label">{a.patient.name}</Text>
          <Text>
            {shortDate(a.date, locale)} · {a.startTime} · {t(`status.${a.status}`)}
          </Text>
          <Text variant="muted">
            {t('patient.home.with', { doctor: a.doctorName ?? '', clinic: a.clinicName })}
          </Text>
          <Text variant="muted">
            {a.consultationTypeName} · {t('queue.token', { token: a.tokenNumber })}
          </Text>
          {a.prescription && (
            <Text variant="muted">
              {t('patient.appts.prescription', { number: a.prescription.number })}
            </Text>
          )}
          {onCancel &&
            (a.canCancel ? (
              <Button
                variant="secondary"
                label={t('patient.appts.cancel')}
                onPress={() => onCancel(a)}
              />
            ) : (
              ['pending', 'confirmed'].includes(a.status) && (
                <Text variant="caption">{t('patient.appts.callToCancel')}</Text>
              )
            ))}
        </Card>
      ))}
    </View>
  );
}
