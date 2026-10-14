import { ConsultationView, PrescriptionView } from '@dhc/contracts';
import { Button, Notice, Screen, Text, useTheme } from '@dhc/ui-native';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ScrollView, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '../../api';
import { errorMessage } from '../../errors';
import { useLocale } from '../../locale/provider';
import { TWO_PANE_MIN_WIDTH } from '../../variant';
import { visits } from '../runtime';
import { isNetworkError } from '../today';
import { NotesSection } from './notes-section';
import { PrescriptionSection } from './prescription-section';
import { VitalsSection } from './vitals-section';

/**
 * The consultation on the Clinic app (PRD §6). On iPad and tablets notes and vitals sit
 * beside the prescription; on phones they stack. Without a network the saved copy of a
 * visit opened today still opens, and notes and vitals can be written (they sync later).
 */
export function ConsultationScreen({ appointmentId }: { appointmentId: string }) {
  const { t } = useLocale();
  const theme = useTheme();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const [view, setView] = useState<ConsultationView | null>(null);
  const [rx, setRx] = useState<PrescriptionView | null>(null);
  const [offline, setOffline] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [v, p] = await Promise.all([
        api.request('GET', `/appointments/${appointmentId}/consultation`, {
          schema: ConsultationView,
        }),
        api.request('GET', `/appointments/${appointmentId}/prescription`, {
          schema: PrescriptionView,
        }),
      ]);
      setView(v);
      setRx(p);
      setOffline(false);
      await visits.put(v);
    } catch (e) {
      if (isNetworkError(e)) {
        const saved = await visits.get(appointmentId);
        setOffline(true);
        if (saved) setView(saved);
        else setError(t('mobile.clinic.needsConnection'));
      } else setError(errorMessage(e, t));
    }
  }, [appointmentId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const back = (
    <Button variant="ghost" label={t('mobile.clinic.back')} onPress={() => router.back()} />
  );
  if (!view) {
    return (
      <Screen>
        {back}
        {error ? (
          <Notice tone="error">{error}</Notice>
        ) : (
          <Text variant="muted">{t('common.loading')}</Text>
        )}
      </Screen>
    );
  }

  const left = (
    <>
      <NotesSection
        key={`notes-${view.consultation?.revision ?? 0}`}
        view={view}
        onSaved={(record) => setView((v) => (v ? { ...v, consultation: record } : v))}
      />
      <VitalsSection view={view} />
    </>
  );
  const right = rx ? (
    <PrescriptionSection
      key={`rx-${rx.prescription?.revision ?? 0}-${rx.prescription?.status ?? 'none'}`}
      view={view}
      rx={rx}
      onChanged={load}
    />
  ) : (
    <Notice>{t('mobile.clinic.rxNeedsConnection')}</Notice>
  );
  const header = (
    <View style={{ gap: theme.spacing[2] }}>
      {back}
      <Text variant="title">
        {view.appointment.patient.name} · {view.appointment.patient.uhid}
      </Text>
      {offline && <Notice tone="warning">{t('mobile.clinic.offlineVisit')}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
    </View>
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: theme.spacing[4], gap: theme.spacing[4] }}
      >
        {header}
        {width >= TWO_PANE_MIN_WIDTH ? (
          <View style={{ flexDirection: 'row', gap: theme.spacing[4], alignItems: 'flex-start' }}>
            <View style={{ flex: 1, gap: theme.spacing[4] }}>{left}</View>
            <View style={{ flex: 1, gap: theme.spacing[4] }}>{right}</View>
          </View>
        ) : (
          <>
            {left}
            {right}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
