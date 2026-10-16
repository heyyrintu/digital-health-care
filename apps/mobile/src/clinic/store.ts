/**
 * Where the Clinic app keeps its offline copy: JSON values by key. The app uses files in
 * its own sandbox (protected by the device's file encryption); tests use memory.
 */
export interface KeyValueStore {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

export function memoryStore(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get: async <T>(key: string) => {
      const raw = data.get(key);
      return raw === undefined ? null : (JSON.parse(raw) as T);
    },
    set: async (key, value) => void data.set(key, JSON.stringify(value)),
    remove: async (key) => void data.delete(key),
  };
}
