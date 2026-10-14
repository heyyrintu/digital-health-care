import type { SyncTodayResponse } from '@dhc/contracts';
import type { KeyValueStore } from './store';

const KEY = 'clinic.today';

export interface TodayState {
  /** The last copy the server sent, or the saved one after a restart. */
  data: SyncTodayResponse | null;
  /** When `data` came from the server (device clock). */
  fetchedAt: number | null;
  /** The last refresh failed for lack of network: the screen says it is a saved copy. */
  offline: boolean;
  error: string | null;
}

export type FetchToday = () => Promise<SyncTodayResponse>;

/** True when the request never reached the API (as opposed to the API refusing it). */
export const isNetworkError = (error: unknown) => error instanceof TypeError;

/**
 * Today's queue as the Clinic app shows it: the live copy while online, the saved copy
 * (with its time) when not. A copy saved on another day is never shown as today's.
 */
export class TodayStore {
  private state: TodayState = { data: null, fetchedAt: null, offline: false, error: null };
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly store: KeyValueStore,
    private readonly today: () => string,
    private readonly now: () => number = Date.now,
  ) {}

  getState = (): TodayState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async load(): Promise<void> {
    const saved = await this.store.get<{ data: SyncTodayResponse; fetchedAt: number }>(KEY);
    if (saved && saved.data.queue.date === this.today() && !this.state.data) {
      this.set({ ...this.state, data: saved.data, fetchedAt: saved.fetchedAt });
    }
  }

  /** Returns whether the server answered. */
  async refresh(fetch: FetchToday, messageOf: (error: unknown) => string): Promise<boolean> {
    try {
      const data = await fetch();
      const fetchedAt = this.now();
      this.set({ data, fetchedAt, offline: false, error: null });
      await this.store.set(KEY, { data, fetchedAt });
      return true;
    } catch (error) {
      this.set({
        ...this.state,
        offline: isNetworkError(error),
        error: isNetworkError(error) ? null : messageOf(error),
      });
      return false;
    }
  }

  async clear(): Promise<void> {
    this.set({ data: null, fetchedAt: null, offline: false, error: null });
    await this.store.remove(KEY);
  }

  private set(state: TodayState) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}
