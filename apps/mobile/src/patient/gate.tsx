import type { PortalPatient } from '@dhc/contracts';
import { Card, Screen, Text } from '@dhc/ui-native';
import type { ReactNode } from 'react';
import { patientAccount } from '../api';
import { useLocale } from '../locale/provider';
import { LoadError, Loading, PatientScreen } from './parts';
import { ConsentsScreen } from './screens/consents';
import { PatientForm } from './screens/patient-form';
import { useAccount } from './use-account';

export interface ReadyAccount {
  patients: PortalPatient[];
  selected: PortalPatient;
}

/**
 * Every patient screen sits behind onboarding: consents first, then the person's own
 * record when the clinic has none on this number. Then the screen gets the family.
 */
export function PatientGate({ children }: { children: (account: ReadyAccount) => ReactNode }) {
  const { t } = useLocale();
  const state = useAccount();
  switch (state.status) {
    case 'loading':
      return (
        <Screen>
          <Loading />
        </Screen>
      );
    case 'error':
      return (
        <Screen>
          <LoadError error={state.error} retry={() => void patientAccount.reload()} />
        </Screen>
      );
    case 'consents':
      return <ConsentsScreen status={state.consents} />;
    case 'profile':
      return (
        <PatientScreen title={t('patient.profile.title')} back={false}>
          <Text variant="muted">{t('patient.profile.intro')}</Text>
          <Card>
            <PatientForm
              submitLabel={t('patient.profile.save')}
              onSaved={() => patientAccount.reload()}
            />
          </Card>
        </PatientScreen>
      );
    case 'ready': {
      const selected = state.patients.find((p) => p.id === state.selectedId)!;
      return <>{children({ patients: state.patients, selected })}</>;
    }
  }
}
