import { ApiError } from '@dhc/api-client';
import type { PortalPatient } from '@dhc/contracts';
import { Button, Choice, Notice, Screen, Text, useTheme } from '@dhc/ui-native';
import { router } from 'expo-router';
import { useEffect, type ReactNode } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { patientAccount } from '../api';
import { errorMessage } from '../errors';
import { useLocale } from '../locale/provider';

/** A titled patient screen with a way back home. */
export function PatientScreen({
  title,
  children,
  back = true,
}: {
  title: string;
  children: ReactNode;
  back?: boolean;
}) {
  const { t } = useLocale();
  return (
    <Screen>
      {back && (
        <View style={{ alignSelf: 'flex-start' }}>
          <Button
            variant="ghost"
            label={t('common.back')}
            onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
          />
        </View>
      )}
      <Text variant="title">{title}</Text>
      {children}
    </Screen>
  );
}

export function Loading() {
  const { t } = useLocale();
  return <ActivityIndicator accessibilityLabel={t('common.loading')} />;
}

/** An error with a retry; a consent withdrawn elsewhere sends the person back to onboarding. */
export function LoadError({ error, retry }: { error: unknown; retry: () => void }) {
  const { t } = useLocale();
  const consentGone = error instanceof ApiError && error.code === 'CONSENT_REQUIRED';
  useEffect(() => {
    if (consentGone) void patientAccount.reload();
  }, [consentGone]);
  return (
    <View style={{ gap: 12 }}>
      <Notice tone="error">{errorMessage(error, t)}</Notice>
      <Button variant="secondary" label={t('common.retry')} onPress={retry} />
    </View>
  );
}

/** A wrapping row of choices with a label above it. */
export function ChoiceRow({ label, children }: { label: string; children: ReactNode }) {
  const theme = useTheme();
  return (
    <View
      style={{ gap: theme.spacing[2] }}
      accessibilityRole="radiogroup"
      accessibilityLabel={label}
    >
      <Text variant="label">{label}</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing[2] }}>
        {children}
      </View>
    </View>
  );
}

/** Picks one of the family; hidden when there is only one. */
export function PatientPicker({
  label,
  patients,
  selectedId,
  onSelect,
}: {
  label: string;
  patients: PortalPatient[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  if (patients.length < 2) return null;
  return (
    <ChoiceRow label={label}>
      {patients.map((p) => (
        <Choice
          key={p.id}
          label={p.name}
          selected={p.id === selectedId}
          onPress={() => onSelect(p.id)}
        />
      ))}
    </ChoiceRow>
  );
}
