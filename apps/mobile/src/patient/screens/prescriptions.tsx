import { Card, Notice, Text, useTheme } from '@dhc/ui-native';
import { View } from 'react-native';
import { api } from '../../api';
import { useLocale } from '../../locale/provider';
import { useLoad } from '../../use-load';
import { shortDate } from '../logic';
import { LoadError, Loading, PatientScreen } from '../parts';

/** PRD §4.4: every signed version; revised and cancelled ones are labelled. */
export function PrescriptionsScreen() {
  const { t, locale } = useLocale();
  const theme = useTheme();
  const { state, reload } = useLoad(() => api.portalPrescriptions(), []);
  return (
    <PatientScreen title={t('patient.nav.prescriptions')}>
      {state.status === 'loading' && <Loading />}
      {state.status === 'error' && <LoadError error={state.error} retry={reload} />}
      {state.status === 'ready' &&
        (state.data.data.length === 0 ? (
          <Text variant="muted">{t('patient.rx.none')}</Text>
        ) : (
          <View style={{ gap: theme.spacing[3] }}>
            <Notice>{t('patient.rx.pdfLater')}</Notice>
            {state.data.data.map((rx) => (
              <Card key={rx.id}>
                <Text variant="label">{rx.patient.name}</Text>
                <Text>
                  {rx.number} · {t('patient.rx.version', { version: rx.version })}
                </Text>
                <Text variant="muted">
                  {rx.doctorName ?? ''} · {shortDate(rx.date, locale)}
                </Text>
                {rx.status === 'superseded' && (
                  <Text variant="caption">{t('patient.rx.superseded')}</Text>
                )}
                {rx.status === 'void' && (
                  <Text variant="caption" style={{ color: theme.colors.destructive }}>
                    {t('patient.rx.void')}
                  </Text>
                )}
              </Card>
            ))}
          </View>
        ))}
    </PatientScreen>
  );
}
