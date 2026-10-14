import { Card, Notice, Text, useTheme } from '@dhc/ui-native';
import { useState } from 'react';
import { View } from 'react-native';
import { patientAccount } from '../../api';
import { useLocale } from '../../locale/provider';
import type { ReadyAccount } from '../gate';
import { PatientScreen } from '../parts';
import { PatientForm } from './patient-form';

/** PRD §4.1: everyone on the number, the children they look after, and adding someone. */
export function FamilyScreen({ account }: { account: ReadyAccount }) {
  const { t } = useLocale();
  const theme = useTheme();
  const [added, setAdded] = useState<string | null>(null);
  const [formKey, setFormKey] = useState(0);
  const adults = account.patients.filter((p) => p.relation === 'account');
  const nameOf = (id: string | null) => account.patients.find((p) => p.id === id)?.name ?? '';

  return (
    <PatientScreen title={t('patient.nav.family')}>
      <Text variant="muted">{t('patient.family.intro')}</Text>
      <View style={{ gap: theme.spacing[3] }}>
        {account.patients.map((p) => (
          <Card key={p.id}>
            <Text variant="label">{p.name}</Text>
            <Text variant="muted">
              {t('patient.uhid')} {p.uhid}
            </Text>
            <Text variant="caption">
              {p.relation === 'account'
                ? t('patient.family.sharesNumber')
                : t('patient.family.lookedAfterBy', { name: nameOf(p.guardianPatientId) })}
            </Text>
          </Card>
        ))}
      </View>
      <Text variant="heading">{t('patient.family.add')}</Text>
      {added && <Notice tone="success">{added}</Notice>}
      <Card>
        <PatientForm
          key={formKey}
          guardians={adults}
          submitLabel={t('patient.family.add')}
          onSaved={async (patient) => {
            setAdded(t('patient.family.added', { name: patient.name }));
            setFormKey((k) => k + 1);
            await patientAccount.reload();
          }}
        />
      </Card>
    </PatientScreen>
  );
}
