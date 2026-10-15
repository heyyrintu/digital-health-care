import { ACCOUNT_CONSENT_KINDS } from '@dhc/contracts';
import { Button, Card, Notice, Text } from '@dhc/ui-native';
import { useState } from 'react';
import { Alert } from 'react-native';
import { api, patientAccount } from '../../api';
import { errorMessage } from '../../errors';
import { useLocale } from '../../locale/provider';
import { useLoad } from '../../use-load';
import { istToday, shortDate } from '../logic';
import { LoadError, Loading, PatientScreen } from '../parts';

/** PRD §4.1: what was accepted and when; the health-data consent can be withdrawn. */
export function PrivacyScreen() {
  const { t, locale } = useLocale();
  const { state, reload } = useLoad(() => api.portalConsents(), []);
  const [error, setError] = useState<string | null>(null);

  const withdraw = () =>
    Alert.alert(t('patient.privacy.withdraw'), t('patient.privacy.withdrawConfirm'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('patient.privacy.withdraw'),
        style: 'destructive',
        onPress: async () => {
          try {
            await api.withdrawHealthDataConsent();
            // Health data is closed now: back to onboarding.
            await patientAccount.reload();
          } catch (e) {
            setError(errorMessage(e, t));
          }
        },
      },
    ]);

  return (
    <PatientScreen title={t('patient.nav.privacy')}>
      {error && <Notice tone="error">{error}</Notice>}
      {state.status === 'loading' && <Loading />}
      {state.status === 'error' && <LoadError error={state.error} retry={reload} />}
      {state.status === 'ready' &&
        ACCOUNT_CONSENT_KINDS.map((kind) => {
          const consent = state.data.consents.find((c) => c.kind === kind);
          return (
            <Card key={kind}>
              <Text variant="label">{t(`patient.privacy.kind.${kind}`)}</Text>
              {consent && (
                <Text variant="muted">
                  {consent.withdrawnAt
                    ? t('patient.privacy.withdrawn', {
                        date: shortDate(istToday(new Date(consent.withdrawnAt)), locale),
                      })
                    : t('patient.privacy.accepted', {
                        date: shortDate(istToday(new Date(consent.acceptedAt)), locale),
                      })}
                </Text>
              )}
              {kind === 'health_data' && consent && !consent.withdrawnAt && (
                <Button
                  variant="destructive"
                  label={t('patient.privacy.withdraw')}
                  onPress={withdraw}
                />
              )}
            </Card>
          );
        })}
      <Text variant="caption">{t('patient.privacy.closeAccount')}</Text>
    </PatientScreen>
  );
}
