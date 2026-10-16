import { ConsultationView, PatientChart, PrescriptionView } from '@dhc/contracts';
import { Button, Notice, Screen, Text, useTheme } from '@dhc/ui-native';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '../../api';
import { errorMessage } from '../../errors';
import { useLocale } from '../../locale/provider';
import { TWO_PANE_MIN_WIDTH } from '../../variant';
import { useOutbox, useToday } from '../hooks';
import { loadOffline, visits } from '../runtime';
import { isNetworkError } from '../today';
import { ChartSection } from './chart-section';
import { NotesSection } from './notes-section';
import { PrescriptionSection } from './prescription-section';
import { VitalsSection } from './vitals-section';

/**
 * The consultation on the Clinic app (PRD §6). On iPad and tablets notes and vitals sit
 * beside the prescription; on phones they stack. Without a network the saved copy of a
 * visit opened today still opens, and notes and vitals can be written (they sync later).
 */
/**
 * Keeps the offline copy of a visit. Written only once the last person's copies are cleared:
 * loadOffline() is remembered once it succeeds and retries that clean-up while it fails.
 */
function cacheVisit(view: ConsultationView, chart: PatientChart | null): Promise<void> {
  return loadOffline()
    .then(() => visits.put(view, chart))
    .catch(() => undefined);
}

export function ConsultationScreen({ appointmentId }: { appointmentId: string }) {
  const { t } = useLocale();
  const theme = useTheme();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const [view, setView] = useState<ConsultationView | null>(null);
  const viewRef = useRef<ConsultationView | null>(null);
  viewRef.current = view;
  const [rx, setRx] = useState<PrescriptionView | null>(null);
  const [chart, setChart] = useState<PatientChart | null>(null);
  const [offline, setOffline] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Each load is numbered; only the latest one's answer is applied, so an earlier request
  // answering last never puts an older revision back on screen.
  // A reload remounts the sections, so it waits while any of them holds unsaved edits.
  const dirty = useRef(new Set<string>());
  const reloadWhenClean = useRef(false);
  const loadSeq = useRef(0);
  // A reload after queued saves were sent that could not reach the server: retried when the
  // queue next reaches it.
  const reloadOwed = useRef(false);
  const load = useCallback(async (): Promise<void> => {
    const mine = ++loadSeq.current;
    setError(null);
    // Saves still waiting on the device are read first: the sections start from them.
    await loadOffline().catch(() => undefined);
    try {
      const [v, p] = await Promise.all([
        api.request('GET', `/appointments/${appointmentId}/consultation`, {
          schema: ConsultationView,
        }),
        api.request('GET', `/appointments/${appointmentId}/prescription`, {
          schema: PrescriptionView,
        }),
      ]);
      const c = await api.request('GET', `/patients/${v.appointment.patient.id}/chart`, {
        schema: PatientChart,
      });
      if (mine !== loadSeq.current) return;
      // Edits started while this was in flight win: apply the server copy once they are saved.
      if (viewRef.current && dirty.current.size > 0) {
        reloadWhenClean.current = true;
        return;
      }
      reloadOwed.current = false;
      setView(v);
      setRx(p);
      setChart(c);
      setOffline(false);
      await cacheVisit(v, c);
    } catch (e) {
      if (mine !== loadSeq.current) return;
      if (isNetworkError(e)) {
        setOffline(true);
        // Already showing the visit: keep it (it is newer than the saved copy) and reload
        // once the network is back.
        if (viewRef.current) {
          reloadOwed.current = true;
          return;
        }
        // While the last person's copies could not be cleared, none is read.
        const saved = await loadOffline().then(
          () => visits.get(appointmentId),
          () => null,
        );
        if (mine !== loadSeq.current) return;
        if (saved) {
          setView(saved.view);
          setChart(saved.chart);
        } else setError(t('mobile.clinic.needsConnection'));
      } else setError(errorMessage(e, t));
    }
  }, [appointmentId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  // Once this visit's waiting notes or vitals have been sent, reload: the server's revision
  // and readings move on, and the next save must start from them, not be refused as stale.
  const items = useOutbox();
  // The queue screen's refresh tells when the server is reachable again.
  const offlineQueue = useToday().offline;
  // By identity, not count: a newer save replacing one being sent keeps the count the same.
  const waiting = items
    .filter((i) => i.status === 'pending' && i.path.startsWith(`/appointments/${appointmentId}/`))
    .map((i) => i.id)
    .join(',');
  const before = useRef(waiting);
  useEffect(() => {
    const now = new Set(waiting.split(',').filter(Boolean));
    const sent = before.current.split(',').some((id) => id && !now.has(id));
    if (sent || (reloadOwed.current && !offlineQueue)) {
      if (dirty.current.size > 0) reloadWhenClean.current = true;
      else void load();
    }
    before.current = waiting;
  }, [waiting, offlineQueue, load]);
  const markDirty = useCallback(
    (section: string, isDirty: boolean) => {
      if (isDirty) dirty.current.add(section);
      else dirty.current.delete(section);
      if (dirty.current.size === 0 && reloadWhenClean.current) {
        reloadWhenClean.current = false;
        void load();
      }
    },
    [load],
  );
  const chartRef = useRef(chart);
  chartRef.current = chart;

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

  // A save updates the copy kept for offline too, so reopening without network shows it. It
  // patches the latest view, so two saves answering out of order never undo each other.
  const keep = (patch: (prev: ConsultationView) => ConsultationView) => {
    setView((prev) => {
      if (!prev) return prev;
      const next = patch(prev);
      void cacheVisit(next, chartRef.current);
      return next;
    });
  };

  const left = (
    <>
      {chart && (
        <ChartSection
          chart={chart}
          editable={view.canEdit && !offline}
          onChange={(next) => {
            setChart(next);
            chartRef.current = next;
            void cacheVisit(view, next);
          }}
        />
      )}
      <NotesSection
        key={`notes-${view.consultation?.revision ?? 0}`}
        view={view}
        onDirty={(d) => markDirty('notes', d)}
        onSaved={(record) => keep((prev) => ({ ...prev, consultation: record }))}
      />
      <VitalsSection
        key={`vitals-${view.vitals?.updatedAt ?? 'none'}`}
        view={view}
        onDirty={(d) => markDirty('vitals', d)}
        onSaved={(vitals) => keep((prev) => ({ ...prev, vitals }))}
      />
    </>
  );
  const right = rx ? (
    <PrescriptionSection
      key={`rx-${rx.prescription?.revision ?? 0}-${rx.prescription?.status ?? 'none'}`}
      view={view}
      rx={rx}
      onDirty={(d) => markDirty('rx', d)}
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
