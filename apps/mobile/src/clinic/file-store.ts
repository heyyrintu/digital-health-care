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
    const text = await file.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      // Unreadable (say a write cut short): keep it aside for support rather than letting the
      // next save overwrite what may be the only copy of queued work, and start empty.
      new File(Paths.document, `${key}.unreadable-${Date.now()}.json`).write(text);
      file.delete();
      return null;
    }
  },
  async set(key, value) {
    // Written aside and moved over the old copy, so a write cut short (the app killed
    // mid-save) leaves the previous file whole instead of half a file.
    const tmp = new File(Paths.document, `${key}.tmp.json`);
    tmp.write(JSON.stringify(value));
    await tmp.move(new File(Paths.document, `${key}.json`), { overwrite: true });
  },
  async remove(key) {
    const file = new File(Paths.document, `${key}.json`);
    if (file.exists) file.delete();
  },
};
