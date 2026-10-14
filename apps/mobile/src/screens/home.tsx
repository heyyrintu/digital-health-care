import type { MeResponse } from '@dhc/contracts';
import { Button, Card, Screen, Text } from '@dhc/ui-native';
import { useState } from 'react';
import { session } from '../api';
import { useLocale } from '../locale/provider';
import { variant } from '../variant';

/**
 * Signed-in home until the Patient and Clinic screens land: who is signed in, where, and
 * sign-out.
 */
export function Home({ me }: { me: MeResponse }) {
  const { t } = useLocale();
  const [busy, setBusy] = useState(false);
  const name = me.user.displayName ?? me.user.phone ?? me.user.email ?? '';

  return (
    <Screen>
      <Text variant="title">
        {variant === 'clinic' ? t('queue.nowServing') : t('portal.welcome', { name })}
      </Text>
      <Card>
        <Text variant="muted">{me.organisation.name}</Text>
        <Text variant="heading">{t('session.signedInAs', { name })}</Text>
        {me.role !== 'patient' && <Text variant="muted">{t(`role.${me.role}`)}</Text>}
        <Button
          variant="secondary"
          label={t('session.signOut')}
          loading={busy}
          onPress={async () => {
            setBusy(true);
            // Signed out on screen even if the keychain could not be cleared.
            await session.signOut().catch(() => undefined);
          }}
        />
      </Card>
    </Screen>
  );
}
