import { Button, Card, Notice, Screen, Text } from '@dhc/ui-native';
import * as LocalAuthentication from 'expo-local-authentication';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { AppState, View } from 'react-native';
import { session } from '../api';
import { useLocale } from '../locale/provider';
import { IdleLock } from './idle-lock';

/** A sign-in finished this recently (password and authenticator) needs no unlock on top. */
const FRESH_SIGN_IN_MS = 30_000;

let freshSignInAt = 0;
let previous = session.getState().status;
session.subscribe(() => {
  const status = session.getState().status;
  // Restoring a saved session goes loading → signed in; a real sign-in comes from signed out.
  if (previous === 'signed_out' && status === 'signed_in') freshSignInAt = Date.now();
  previous = status;
});

/**
 * Keeps a lost or unattended Clinic device closed (threat model T13): it locks after 15
 * minutes without a touch, and when the app opens on a saved session. Face ID, fingerprint
 * or the device passcode reopens it; the session itself stays signed in.
 */
export function LockGate({ children }: { children: ReactNode }) {
  const { t } = useLocale();
  const [lock] = useState(
    () => new IdleLock(Date.now(), { locked: Date.now() - freshSignInAt > FRESH_SIGN_IN_MS }),
  );
  const [locked, setLocked] = useState(lock.isLocked);
  const [error, setError] = useState<string | null>(null);
  const [noDeviceLock, setNoDeviceLock] = useState(false);
  const [busy, setBusy] = useState(false);

  const check = useCallback(() => {
    if (lock.check(Date.now())) setLocked(true);
  }, [lock]);

  useEffect(() => {
    // Often enough that the lock lands within seconds of the 15-minute limit.
    const timer = setInterval(check, 5_000);
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') check();
    });
    return () => {
      clearInterval(timer);
      sub.remove();
    };
  }, [check, lock]);

  const unlock = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const level = await LocalAuthentication.getEnrolledLevelAsync();
      if (level === LocalAuthentication.SecurityLevel.NONE) {
        setNoDeviceLock(true);
        return;
      }
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: t('mobile.clinic.unlockPrompt'),
        disableDeviceFallback: false,
      });
      if (result.success) {
        lock.unlock(Date.now());
        setLocked(false);
      } else if (result.error !== 'user_cancel' && result.error !== 'system_cancel') {
        setError(t('mobile.clinic.unlockFailed'));
      }
    } finally {
      setBusy(false);
    }
  }, [lock, t]);

  // Ask straight away when the lock screen appears, once per lock: `unlock` changes when the
  // saved language loads, and that must not ask a second time.
  const asked = useRef(false);
  useEffect(() => {
    if (!locked) {
      asked.current = false;
      return;
    }
    if (asked.current) return;
    asked.current = true;
    void unlock();
  }, [locked, unlock]);

  if (!locked) {
    return (
      <View
        style={{ flex: 1 }}
        onStartShouldSetResponderCapture={() => {
          // Past the limit the touch locks the app instead of reaching the screen.
          if (lock.activity(Date.now())) {
            setLocked(true);
            return true;
          }
          return false;
        }}
      >
        {children}
      </View>
    );
  }
  return (
    <Screen>
      <Text variant="title">{t('mobile.clinic.lockedTitle')}</Text>
      <Card>
        <Text>{t('mobile.clinic.lockedBody')}</Text>
        {noDeviceLock && <Notice tone="error">{t('mobile.clinic.noDeviceLock')}</Notice>}
        {error && <Notice tone="error">{error}</Notice>}
        <Button label={t('mobile.clinic.unlock')} loading={busy} onPress={() => void unlock()} />
        <Button
          variant="secondary"
          label={t('session.signOut')}
          onPress={() => void session.signOut()}
        />
      </Card>
    </Screen>
  );
}
