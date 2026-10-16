import { Button, Notice, Screen, Text } from '@dhc/ui-native';
import { useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator } from 'react-native';
import { session } from '../../src/api';
import { lastOrganisation } from '../../src/auth/vault';
import { useLocale } from '../../src/locale/provider';
import { PatientSignIn } from '../../src/screens/patient-sign-in';
import { StaffSignIn } from '../../src/screens/staff-sign-in';
import { useSession } from '../../src/session-context';
import { variant } from '../../src/variant';

/**
 * The sign-in screen for this app: SMS code for patients, password and authenticator for
 * staff. A clinic link (`…/sign-in?clinic=demo-clinic`) fills in the clinic ID.
 */
export default function SignInRoute() {
  const { t } = useLocale();
  const state = useSession();
  const params = useLocalSearchParams<{ clinic?: string | string[] }>();
  // A link with the clinic twice arrives as a list; the first one counts.
  const clinic = Array.isArray(params.clinic) ? params.clinic[0] : params.clinic;
  const [saved, setSaved] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    void lastOrganisation()
      .catch(() => null)
      .then(setSaved);
  }, []);

  if (state.status === 'loading' || saved === undefined) {
    return (
      <Screen>
        <ActivityIndicator accessibilityLabel={t('common.loading')} />
      </Screen>
    );
  }

  if (state.status === 'unreachable') {
    return (
      <Screen>
        <Text variant="title">{t('mobile.unreachableTitle')}</Text>
        <Notice tone="warning">{t('error.network')}</Notice>
        <Button label={t('common.retry')} onPress={() => void session.restore()} />
      </Screen>
    );
  }

  const notice =
    state.status === 'signed_out' && state.reason === 'expired' ? t('session.expired') : undefined;
  const initialOrganisation = clinic ?? saved ?? undefined;
  return variant === 'clinic' ? (
    <StaffSignIn initialOrganisation={initialOrganisation} notice={notice} />
  ) : (
    <PatientSignIn initialOrganisation={initialOrganisation} notice={notice} />
  );
}
