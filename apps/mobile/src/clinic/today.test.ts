import type { SyncTodayResponse } from '@dhc/contracts';
import { describe, expect, it } from 'vitest';
import { memoryStore } from './store';
import { TodayStore } from './today';

const snapshot = (date: string): SyncTodayResponse => ({
  serverTime: `${date}T04:30:00.000Z`,
  queue: {
    date,
    myOpd: [],
    booked: [],
    completed: [],
    closed: [],
    followUps: [],
    averageConsultationMinutes: null,
  },
  templates: [],
});

describe('TodayStore', () => {
  it('saves the live copy and falls back to it, marked offline, without a network', async () => {
    const store = memoryStore();
    const today = new TodayStore(
      store,
      () => '2026-10-06',
      () => 100,
    );
    expect(await today.refresh(async () => snapshot('2026-10-06'), String)).toBe(true);

    const restarted = new TodayStore(
      store,
      () => '2026-10-06',
      () => 200,
    );
    await restarted.load();
    expect(restarted.getState()).toMatchObject({ fetchedAt: 100, offline: false });
    const ok = await restarted.refresh(async () => {
      throw new TypeError('Network request failed');
    }, String);
    expect(ok).toBe(false);
    expect(restarted.getState()).toMatchObject({ offline: true, fetchedAt: 100, error: null });
    expect(restarted.getState().data?.queue.date).toBe('2026-10-06');
  });

  it('never shows yesterday’s saved queue as today’s, and reports server refusals', async () => {
    const store = memoryStore();
    await new TodayStore(store, () => '2026-10-05').refresh(
      async () => snapshot('2026-10-05'),
      String,
    );
    const next = new TodayStore(store, () => '2026-10-06');
    await next.load();
    expect(next.getState().data).toBeNull();

    await next.refresh(
      async () => {
        throw new Error('You do not have access to this.');
      },
      (e) => (e as Error).message,
    );
    expect(next.getState()).toMatchObject({
      offline: false,
      error: 'You do not have access to this.',
    });
  });
});
