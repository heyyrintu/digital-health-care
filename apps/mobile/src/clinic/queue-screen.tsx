import type { Appointment, MeResponse } from '@dhc/contracts';
import { istDateKey } from '@dhc/domain';
import type { MessageKey } from '@dhc/i18n';
import { Button, Card, Notice, Text, useTheme } from '@dhc/ui-native';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AppState,
  FlatList,
  Pressable,
  RefreshControl,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { errorMessage } from '../errors';
import { useLocale } from '../locale/provider';
import { TWO_PANE_MIN_WIDTH } from '../variant';
import { pendingCheckIns } from './actions';
import { AppointmentDetailPane } from './appointment-detail';
import { useOutbox, useToday } from './hooks';
import { outbox, syncNow } from './runtime';

const TABS = ['myOpd', 'booked', 'completed', 'closed'] as const;
type Tab = (typeof TABS)[number];

/** As on the web queue: refresh every 15 seconds while the app is open. */
const REFRESH_MS = 15_000;

/**
 * The Clinic app's queue (PRD §5.1): the same tabs as the web, the saved copy when the
 * network drops, and on iPad and tablets the selected patient beside the list (ADR 0005).
 */
export function QueueScreen({ me }: { me: MeResponse }) {
  const { t, locale } = useLocale();
  const theme = useTheme();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const twoPane = width >= TWO_PANE_MIN_WIDTH;
  const state = useToday();
  const items = useOutbox();
  const [tab, setTab] = useState<Tab>('myOpd');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(() => new Date());

  const messageOf = useCallback((e: unknown) => errorMessage(e, t), [t]);
  const refresh = useCallback(async () => {
    await syncNow(messageOf);
    setNow(new Date());
  }, [messageOf]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      if (AppState.currentState === 'active') void refresh();
    }, REFRESH_MS);
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') void refresh();
    });
    return () => {
      clearInterval(timer);
      sub.remove();
    };
  }, [refresh]);

  const queue = state.data?.queue;
  const pending = useMemo(() => pendingCheckIns(items), [items]);
  const failed = items.filter((i) => i.status === 'failed');
  const waiting = items.filter((i) => i.status === 'pending').length;
  const rows = queue ? queue[tab] : [];
  const selected = useMemo(
    () => (queue && selectedId ? findAppointment(queue, selectedId) : null),
    [queue, selectedId],
  );
  const time = (ms: number) =>
    new Date(ms).toLocaleTimeString(locale === 'hi' ? 'hi-IN' : 'en-IN', {
      hour: '2-digit',
      minute: '2-digit',
    });

  const list = (
    <View style={{ flex: 1, gap: theme.spacing[3] }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing[2] }}>
        {TABS.map((key) => (
          <Pressable
            key={key}
            accessibilityRole="tab"
            accessibilityState={{ selected: tab === key }}
            onPress={() => setTab(key)}
            style={{
              minHeight: theme.minTouchTarget,
              paddingHorizontal: theme.spacing[3],
              borderRadius: theme.radii.md,
              justifyContent: 'center',
              backgroundColor: tab === key ? theme.colors.card : theme.colors.muted,
              borderWidth: 1,
              borderColor: tab === key ? theme.colors.border : theme.colors.muted,
            }}
          >
            <Text variant="label">
              {t(`queue.tab.${key}` as MessageKey)} {queue ? queue[key].length : '–'}
            </Text>
          </Pressable>
        ))}
      </View>
      {state.offline && state.fetchedAt && (
        <Notice tone="warning">
          {t('mobile.clinic.offlineCopy', { time: time(state.fetchedAt) })}
        </Notice>
      )}
      {state.error && <Notice tone="error">{state.error}</Notice>}
      {waiting > 0 && <Notice>{t('mobile.clinic.waitingToSync', { count: waiting })}</Notice>}
      {failed.map((item) => (
        <Card key={item.id}>
          <Notice tone="error">
            {t('mobile.clinic.syncFailed', { label: item.label, reason: item.error ?? '' })}
          </Notice>
          <Button
            variant="secondary"
            label={t('mobile.clinic.discard')}
            onPress={() => void outbox.discard(item.id)}
          />
        </Card>
      ))}
      <FlatList
        data={rows}
        keyExtractor={(a) => a.id}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => {
              setRefreshing(true);
              await refresh();
              setRefreshing(false);
            }}
          />
        }
        ListEmptyComponent={
          <Text variant="muted">
            {queue ? t(`queue.empty.${tab}` as MessageKey) : t('common.loading')}
          </Text>
        }
        ItemSeparatorComponent={() => <View style={{ height: theme.spacing[2] }} />}
        renderItem={({ item: a }) => (
          <QueueRow
            a={a}
            now={now}
            selected={twoPane && a.id === selectedId}
            pendingCheckIn={pending.has(a.id)}
            onPress={() => (twoPane ? setSelectedId(a.id) : router.push(`/appointment/${a.id}`))}
          />
        )}
      />
    </View>
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <View style={{ flex: 1, padding: theme.spacing[4], gap: theme.spacing[3] }}>
        <View
          style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}
        >
          <Text variant="title">{t('queue.title')}</Text>
          <Text variant="muted">
            {me.organisation.name}
            {state.fetchedAt && !state.offline
              ? ` · ${t('queue.updated', { time: time(state.fetchedAt) })}`
              : ''}
          </Text>
        </View>
        {twoPane ? (
          <View style={{ flex: 1, flexDirection: 'row', gap: theme.spacing[4] }}>
            <View style={{ flex: 2 }}>{list}</View>
            <View style={{ flex: 3 }}>
              {selected ? (
                <AppointmentDetailPane
                  a={selected}
                  me={me}
                  today={istDateKey(now)}
                  pendingCheckIn={pending.has(selected.id)}
                  onChanged={refresh}
                />
              ) : (
                <Card>
                  <Text variant="muted">{t('mobile.clinic.selectPatient')}</Text>
                </Card>
              )}
            </View>
          </View>
        ) : (
          list
        )}
      </View>
    </SafeAreaView>
  );
}

export function findAppointment(
  queue: {
    myOpd: Appointment[];
    booked: Appointment[];
    completed: Appointment[];
    closed: Appointment[];
  },
  id: string,
): Appointment | null {
  return (
    [...queue.myOpd, ...queue.booked, ...queue.completed, ...queue.closed].find(
      (a) => a.id === id,
    ) ?? null
  );
}

const minutesSince = (iso: string | null, now: Date) =>
  iso ? Math.max(0, Math.floor((now.getTime() - Date.parse(iso)) / 60_000)) : 0;

function QueueRow({
  a,
  now,
  selected,
  pendingCheckIn,
  onPress,
}: {
  a: Appointment;
  now: Date;
  selected: boolean;
  pendingCheckIn: boolean;
  onPress: () => void;
}) {
  const { t } = useLocale();
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${t('queue.token', { token: a.tokenNumber })}, ${a.patient.name}`}
      onPress={onPress}
      style={{
        flexDirection: 'row',
        gap: theme.spacing[3],
        padding: theme.spacing[3],
        minHeight: theme.minTouchTarget,
        borderRadius: theme.radii.xl,
        borderWidth: 1,
        borderColor: selected ? theme.colors.primary : theme.colors.border,
        backgroundColor: theme.colors.card,
      }}
    >
      <View
        style={{
          width: 48,
          height: 48,
          borderRadius: theme.radii.lg,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor:
            a.status === 'in_consultation' ? theme.colors.primary : theme.colors.accent,
        }}
      >
        <Text
          variant="heading"
          style={{
            color:
              a.status === 'in_consultation'
                ? theme.colors['primary-foreground']
                : theme.colors['accent-foreground'],
          }}
        >
          {a.tokenNumber}
        </Text>
      </View>
      <View style={{ flex: 1, gap: theme.spacing[1] }}>
        <Text variant="label">
          {a.source === 'walk_in' ? t('appointments.walkInBadge') : a.startTime} · {a.patient.name}
        </Text>
        <Text variant="muted">
          {a.patient.uhid} · {t(`status.${a.status}` as MessageKey)}
          {a.status === 'checked_in'
            ? ` · ${t('queue.waiting', { minutes: minutesSince(a.checkedInAt, now) })}`
            : ''}
        </Text>
        {pendingCheckIn && <Text variant="caption">{t('mobile.clinic.pendingCheckIn')}</Text>}
      </View>
    </Pressable>
  );
}
