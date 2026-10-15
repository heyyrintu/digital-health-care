import { istDateKey } from '@dhc/domain';
import { Button, Screen, Text } from '@dhc/ui-native';
import { Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo } from 'react';
import { pendingCheckIns } from '../../../src/clinic/actions';
import { AppointmentDetailPane } from '../../../src/clinic/appointment-detail';
import { useOutbox, useToday } from '../../../src/clinic/hooks';
import { findAppointment } from '../../../src/clinic/queue-screen';
import { syncNow } from '../../../src/clinic/runtime';
import { errorMessage } from '../../../src/errors';
import { useLocale } from '../../../src/locale/provider';
import { useSession } from '../../../src/session-context';

/** On phones the selected patient opens on its own screen (on iPad it sits beside the list). */
export default function AppointmentRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { t } = useLocale();
  const state = useSession();
  const today = useToday();
  const items = useOutbox();
  const pending = useMemo(() => pendingCheckIns(items), [items]);
  const refresh = useCallback(() => syncNow((e) => errorMessage(e, t)), [t]);
  // Opened from a link, the queue may not be loaded yet: fetch it rather than say no match.
  const loaded = today.data !== null;
  useEffect(() => {
    if (!loaded) void refresh();
  }, [loaded, refresh]);

  if (state.status !== 'signed_in') return <Redirect href="/sign-in" />;
  const a = today.data ? findAppointment(today.data.queue, id) : null;
  return (
    <Screen>
      <Button variant="ghost" label={t('mobile.clinic.back')} onPress={() => router.back()} />
      {a ? (
        <AppointmentDetailPane
          a={a}
          me={state.me}
          today={istDateKey(new Date())}
          pendingCheckIn={pending.has(a.id)}
          onChanged={refresh}
        />
      ) : (
        <Text variant="muted">{today.data ? t('queue.noMatch') : t('common.loading')}</Text>
      )}
    </Screen>
  );
}
