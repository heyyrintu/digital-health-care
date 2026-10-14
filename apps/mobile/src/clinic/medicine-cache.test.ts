import type { SyncMedicine, SyncMedicinesResponse } from '@dhc/contracts';
import { describe, expect, it } from 'vitest';
import { MedicineCache } from './medicine-cache';
import { memoryStore } from './store';

const med = (id: string, name: string, active = true): SyncMedicine => ({
  id,
  name,
  genericName: name.toUpperCase(),
  composition: `${name} 500 mg`,
  form: 'tablet',
  defaultRoute: 'oral',
  source: 'clinic',
  active,
  updatedAt: '2026-10-06T04:00:00.000Z',
});

const page = (
  data: SyncMedicine[],
  cursor: string,
  hasMore = false,
  aliases: SyncMedicinesResponse['aliases'] = [],
): SyncMedicinesResponse => ({ data, cursor, hasMore, aliases });

describe('MedicineCache', () => {
  it('downloads every page, then applies only what changed from the saved cursor', async () => {
    const store = memoryStore();
    const cache = new MedicineCache(store, () => 42);
    const cursors: (string | undefined)[] = [];
    const pages = [
      page([med('m1', 'Paracetamol'), med('m2', 'Amoxicillin')], 'c1', true),
      page([med('m3', 'Cetirizine')], 'c2'),
    ];
    await cache.sync(async (cursor) => {
      cursors.push(cursor);
      return pages.shift()!;
    });
    expect(cursors).toEqual([undefined, 'c1']);
    expect(cache.size).toBe(3);
    expect(cache.syncedAt).toBe(42);

    // Restart: the saved copy and cursor come back.
    const again = new MedicineCache(store);
    await again.load();
    const later: (string | undefined)[] = [];
    await again.sync(async (cursor) => {
      later.push(cursor);
      return page([med('m2', 'Amoxicillin', false), med('m4', 'Ibuprofen')], 'c3', false, [
        { name: 'Crocin', medicineId: 'm1' },
      ]);
    });
    expect(later).toEqual(['c2']);
    expect(again.search('amox')).toEqual([]);
    expect(again.search('crocin').map((m) => m.id)).toEqual(['m1']);
    expect(again.search('500').map((m) => m.name)).toEqual([
      'Cetirizine',
      'Ibuprofen',
      'Paracetamol',
    ]);
    expect(again.search('p')).toEqual([]);
  });

  it('keeps the previous copy when a sync fails part-way', async () => {
    const cache = new MedicineCache(memoryStore());
    await cache.sync(async () => page([med('m1', 'Paracetamol')], 'c1'));
    let calls = 0;
    await expect(
      cache.sync(async () => {
        calls += 1;
        if (calls === 1) return page([med('m1', 'Paracetamol', false)], 'c2', true);
        throw new TypeError('Network request failed');
      }),
    ).rejects.toThrow();
    expect(calls).toBe(2);
    expect(cache.search('para')).toHaveLength(1);
  });

  it('drops a sync that was still running when the person signed out', async () => {
    const store = memoryStore();
    const cache = new MedicineCache(store);
    let answer: (value: SyncMedicinesResponse) => void = () => undefined;
    const running = cache.sync(() => new Promise((resolve) => (answer = resolve)));
    await cache.clear();
    answer(page([med('m1', 'Paracetamol')], 'c1'));
    await running;
    expect(cache.size).toBe(0);
    expect(await store.get('clinic.medicines')).toBeNull();
  });
});
