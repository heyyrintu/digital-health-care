import * as SecureStore from 'expo-secure-store';
import type { StoredSession, TokenVault } from './session';

const SESSION_KEY = 'dhc.session';
const ORGANISATION_KEY = 'dhc.organisation';

/**
 * Keychain (iOS) and Keystore (Android). This-device-only keeps the refresh token out of
 * backups and device transfers; after-first-unlock lets a refresh run while the screen is locked.
 */
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

export const secureVault: TokenVault = {
  async load() {
    const raw = await SecureStore.getItemAsync(SESSION_KEY, OPTIONS);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as Partial<StoredSession>;
      if (typeof parsed.organisation === 'string' && typeof parsed.refreshToken === 'string') {
        return { organisation: parsed.organisation, refreshToken: parsed.refreshToken };
      }
    } catch {
      // Unreadable: treat as signed out.
    }
    return null;
  },
  async save(session) {
    await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(session), OPTIONS);
    await SecureStore.setItemAsync(ORGANISATION_KEY, session.organisation, OPTIONS);
  },
  async clear() {
    await SecureStore.deleteItemAsync(SESSION_KEY, OPTIONS);
  },
};

/** The clinic ID last signed in to, kept after sign-out so the form is prefilled. */
export function lastOrganisation(): Promise<string | null> {
  return SecureStore.getItemAsync(ORGANISATION_KEY, OPTIONS);
}
