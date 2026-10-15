import { ThemeProvider } from '@dhc/ui-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { session } from '../src/api';
import { LocaleProvider } from '../src/locale/provider';
import { useSession } from '../src/session-context';

/**
 * Signed-out people only reach the (auth) screens and signed-in people only the (app) ones;
 * expo-router moves between them when the session changes.
 */
export default function RootLayout() {
  useEffect(() => {
    void session.restore();
  }, []);

  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <LocaleProvider>
          <StatusBar style="auto" />
          <Routes />
        </LocaleProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

function Routes() {
  const state = useSession();
  const signedIn = state.status === 'signed_in';
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Protected guard={signedIn}>
        <Stack.Screen name="(app)" />
      </Stack.Protected>
      <Stack.Protected guard={!signedIn}>
        <Stack.Screen name="(auth)" />
      </Stack.Protected>
    </Stack>
  );
}
