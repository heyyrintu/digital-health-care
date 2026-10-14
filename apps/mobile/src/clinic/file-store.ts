import { File, Paths } from 'expo-file-system';
import type { KeyValueStore } from './store';

/**
 * JSON files in the app's document directory. They never leave the app sandbox, which iOS
 * Data Protection and Android file-based encryption keep encrypted while the device is
 * locked (threat model T13); signing out deletes them.
 */
export const fileStore: KeyValueStore = {
  async get<T>(key: string) {
    const file = new File(Paths.document, `${key}.json`);
    if (!file.exists) return null;
    try {
      return JSON.parse(await file.text()) as T;
    } catch {
      return null;
    }
  },
  async set(key, value) {
    new File(Paths.document, `${key}.json`).write(JSON.stringify(value));
  },
  async remove(key) {
    const file = new File(Paths.document, `${key}.json`);
    if (file.exists) file.delete();
  },
};
