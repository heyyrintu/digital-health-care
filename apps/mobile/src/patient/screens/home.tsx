import type { MeResponse, PortalAppointment } from '@dhc/contracts';
import { Button, Card, Screen, Text, useTheme } from '@dhc/ui-native';
import { router, useFocusEffect, type Href } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { View } from 'react-native';
import { api, patientAccount, session } from '../../api';
import { useLocale } from '../../locale/provider';
import { useLoad } from '../../use-load';
import type { ReadyAccount } from '../gate';
import { shortDate } from '../logic';
import { LoadError, Loading, PatientPicker } from '../parts';

/** PRD §4.2: patient switcher, next appointment and quick actions. */
export function PatientHome({ me, account }: { me: MeResponse; account: ReadyAccount }) {
  const { t, locale } = useLocale();
  const theme = useTheme();
  const [busy, setBusy] = useState(false);
  const { state, reload } = useLoad(() => api.portalAppointments(), []);
  const { selected } = account;
  // Back from booking or cancelling: show the next visit as it is now.
  const shown = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (shown.current) void reload();
      shown.current = true;
    }, [reload]),
  );

  const next: PortalAppointment | undefined =
    state.status === 'ready'
      ? state.data.upcoming.find((a) => a.patient.id === selected.id)
      : undefined;

  const go = (href: Href) => router.push(href);

  return (
    <Screen>
      <Text variant="muted">{me.organisation.name}</Text>
      <Text variant="title">{t('portal.welcome', { name: selected.name })}</Text>
      <PatientPicker
        label={t('patient.home.switcher')}
        patients={account.patients}
        selectedId={selected.id}
        onSelect={(id) => patientAccount.select(id)}
      />

      <Card>
        <Text variant="heading">{t('patient.home.next')}</Text>
        {state.status === 'loading' && <Loading />}
        {state.status === 'error' && <LoadError error={state.error} retry={reload} />}
        {state.status === 'ready' &&
          (next ? (
            <View style={{ gap: theme.spacing[1] }}>
              <Text>
                {shortDate(next.date, locale)} · {next.startTime}
              </Text>
              <Text variant="muted">
                {next.doctorName
                  ? t('patient.home.with', { doctor: next.doctorName, clinic: next.clinicName })
                  : next.clinicName}
              </Text>
              <Text variant="muted">
                {t('queue.token', { token: next.tokenNumber })} · {t(`status.${next.status}`)}
              </Text>
            </View>
          ) : (
            <Text variant="muted">{t('patient.home.noNext')}</Text>
          ))}
        <Button label={t('booking.book')} onPress={() => go('/book')} />
      </Card>

      <View style={{ gap: theme.spacing[2] }}>
        <Button
          variant="secondary"
          label={t('patient.nav.appointments')}
          onPress={() => go('/appointments')}
        />
        <Button
          variant="secondary"
          label={t('patient.nav.prescriptions')}
          onPress={() => go('/prescriptions')}
        />
        <Button variant="secondary" label={t('patient.nav.family')} onPress={() => go('/family')} />
        <Button
          variant="secondary"
          label={t('patient.nav.privacy')}
          onPress={() => go('/privacy')}
        />
        <Button
          variant="ghost"
          label={t('session.signOut')}
          loading={busy}
          onPress={async () => {
            setBusy(true);
            await session.signOut();
          }}
        />
      </View>
    </Screen>
  );
}
