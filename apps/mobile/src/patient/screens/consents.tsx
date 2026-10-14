import {
  ACCOUNT_CONSENT_KINDS,
  CURRENT_CONSENT_VERSIONS,
  type AccountConsentKind,
  type ConsentStatus,
} from '@dhc/contracts';
import { Button, Card, Notice, Text, useTheme } from '@dhc/ui-native';
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { api, patientAccount } from '../../api';
import { errorMessage } from '../../errors';
import { useLocale } from '../../locale/provider';
import { LanguageSwitch } from '../../screens/language-switch';
import { PatientScreen } from '../parts';

/** Onboarding (PRD §4.1): the privacy notice, terms and the separate health-data consent. */
export function ConsentsScreen({ status }: { status: ConsentStatus }) {
  const { t } = useLocale();
  const theme = useTheme();
  const [ticked, setTicked] = useState<Set<AccountConsentKind>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = ACCOUNT_CONSENT_KINDS.filter((k) => status.pending.includes(k));
  const updating = status.consents.length > 0;
  const all = pending.every((k) => ticked.has(k));

  const toggle = (kind: AccountConsentKind) =>
    setTicked((current) => {
      const next = new Set(current);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });

  const accept = async () => {
    if (!all) return setError(t('patient.consents.all'));
    setBusy(true);
    setError(null);
    try {
      await api.acceptConsents(
        pending.map((kind) => ({ kind, version: CURRENT_CONSENT_VERSIONS[kind] })),
      );
      await patientAccount.reload();
    } catch (e) {
      setError(errorMessage(e, t));
      setBusy(false);
    }
  };

  return (
    <PatientScreen title={t('patient.consents.title')} back={false}>
      <Text variant="muted">
        {updating ? t('patient.consents.updated') : t('patient.consents.intro')}
      </Text>
      {error && <Notice tone="error">{error}</Notice>}
      <Card>
        {pending.map((kind) => (
          <Pressable
            key={kind}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: ticked.has(kind) }}
            onPress={() => toggle(kind)}
            style={{
              flexDirection: 'row',
              gap: theme.spacing[3],
              alignItems: 'flex-start',
              minHeight: theme.minTouchTarget,
            }}
          >
            <View
              style={{
                width: 24,
                height: 24,
                marginTop: 2,
                borderRadius: theme.radii.sm / 2,
                borderWidth: 2,
                borderColor: theme.colors.primary,
                backgroundColor: ticked.has(kind) ? theme.colors.primary : 'transparent',
              }}
            />
            <View style={{ flex: 1, gap: theme.spacing[1] }}>
              <Text>{t(`patient.consents.${kind}`)}</Text>
              {kind === 'health_data' && (
                <Text variant="caption">{t('patient.consents.healthDataHint')}</Text>
              )}
            </View>
          </Pressable>
        ))}
        <Button label={t('patient.consents.accept')} loading={busy} onPress={accept} />
      </Card>
      <LanguageSwitch />
    </PatientScreen>
  );
}
