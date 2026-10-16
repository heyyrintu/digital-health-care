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

describe('TodayStore across a sign-out and midnight', () => {
  it('keeps the newer queue when an older refresh answers last', async () => {
    const store = memoryStore();
    const today = new TodayStore(store, () => '2026-10-06');
    let answerOld: (value: SyncTodayResponse) => void = () => undefined;
    const older = today.refresh(() => new Promise((resolve) => (answerOld = resolve)), String);
    const newer = snapshot('2026-10-06');
    expect(await today.refresh(async () => newer, String)).toBe(true);
    answerOld({ ...snapshot('2026-10-06'), serverTime: '2026-10-06T04:00:00.000Z' });
    expect(await older).toBe(false);
    expect(today.getState().data).toBe(newer);
  });

  it('drops an answer for yesterday that arrives after midnight', async () => {
    const store = memoryStore();
    const today = new TodayStore(store, () => '2026-10-07');
    expect(await today.refresh(async () => snapshot('2026-10-06'), String)).toBe(false);
    expect(today.getState().data).toBeNull();
    expect(await store.get('clinic.today')).toBeNull();
  });

  it('removes a copy whose save finished after a sign-out', async () => {
    const inner = memoryStore();
    let release: () => void = () => undefined;
    const store = {
      ...inner,
      set: async (key: string, value: unknown) => {
        await new Promise<void>((resolve) => (release = resolve));
        await inner.set(key, value);
      },
    };
    const today = new TodayStore(store, () => '2026-10-06');
    const refreshing = today.refresh(async () => snapshot('2026-10-06'), String);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const clearing = today.clear();
    release();
    expect(await refreshing).toBe(false);
    await clearing;
    expect(await inner.get('clinic.today')).toBeNull();
  });

  it('drops a refresh that answers after the person signed out', async () => {
    const store = memoryStore();
    const today = new TodayStore(store, () => '2026-10-06');
    let answer: (value: SyncTodayResponse) => void = () => undefined;
    const refreshing = today.refresh(() => new Promise((resolve) => (answer = resolve)), String);
    await today.clear();
    answer(snapshot('2026-10-06'));
    expect(await refreshing).toBe(false);
    expect(today.getState().data).toBeNull();
    expect(await store.get('clinic.today')).toBeNull();
  });

  it('stops showing yesterday’s queue when a refresh after midnight fails', async () => {
    let date = '2026-10-06';
    const today = new TodayStore(memoryStore(), () => date);
    await today.refresh(async () => snapshot('2026-10-06'), String);
    date = '2026-10-07';
    await today.refresh(async () => {
      throw new TypeError('Network request failed');
    }, String);
    expect(today.getState()).toMatchObject({ data: null, fetchedAt: null, offline: true });
  });

  it('still reports the server answered when keeping the copy fails', async () => {
    const store = { ...memoryStore(), set: async () => Promise.reject(new Error('disk full')) };
    const today = new TodayStore(store, () => '2026-10-06');
    expect(await today.refresh(async () => snapshot('2026-10-06'), String)).toBe(true);
  });
});
