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
  /** Bumped by clear(): a refresh started before a sign-out is dropped when it answers. */
  private generation = 0;
  /** Numbers each refresh: only the latest one's answer is shown and kept. */
  private seq = 0;
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
    const generation = this.generation;
    const saved = await this.store.get<{ data: SyncTodayResponse; fetchedAt: number }>(KEY);
    if (generation !== this.generation) return;
    if (saved && saved.data.queue.date === this.today() && !this.state.data) {
      this.set({ ...this.state, data: saved.data, fetchedAt: saved.fetchedAt });
    }
  }

  /** Returns whether the server answered. */
  async refresh(fetch: FetchToday, messageOf: (error: unknown) => string): Promise<boolean> {
    const generation = this.generation;
    const mine = ++this.seq;
    let data: SyncTodayResponse;
    try {
      data = await fetch();
    } catch (error) {
      if (generation !== this.generation || mine !== this.seq) return false;
      // Past midnight the copy kept from yesterday is not today's queue.
      const stale = this.state.data && this.state.data.queue.date !== this.today();
      this.set({
        ...this.state,
        ...(stale ? { data: null, fetchedAt: null } : {}),
        offline: isNetworkError(error),
        error: isNetworkError(error) ? null : messageOf(error),
      });
      return false;
    }
    // A newer refresh overtook this one, or this answer is from before midnight: the
    // screen and the saved copy keep the newer, today's, queue.
    if (generation !== this.generation || mine !== this.seq) return false;
    if (data.queue.date !== this.today()) return false;
    const fetchedAt = this.now();
    this.set({ data, fetchedAt, offline: false, error: null });
    // The server answered; failing to keep a copy only costs the offline fallback.
    await this.store.set(KEY, { data, fetchedAt }).catch(() => undefined);
    return generation === this.generation;
  }

  async clear(): Promise<void> {
    this.generation += 1;
    this.set({ data: null, fetchedAt: null, offline: false, error: null });
    await this.store.remove(KEY);
  }

  private set(state: TodayState) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}
