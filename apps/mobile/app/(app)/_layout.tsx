import { Stack } from 'expo-router';
import { useEffect } from 'react';
import { LockGate } from '../../src/clinic/lock-gate';
import { registerForPush } from '../../src/clinic/push';
import { loadOffline } from '../../src/clinic/runtime';
import { variant } from '../../src/variant';

export default function AppLayout() {
  useEffect(() => {
    if (variant !== 'clinic') return;
    // A failed clean-up is retried by the next read.
    loadOffline().catch(() => undefined);
    void registerForPush(null);
  }, []);

  const stack = <Stack screenOptions={{ headerShown: false }} />;
  // The Clinic app locks when idle; the Patient app relies on the device lock for now.
  return variant === 'clinic' ? <LockGate>{stack}</LockGate> : stack;
}
