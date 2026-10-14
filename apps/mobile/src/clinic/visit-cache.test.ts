import type { ConsultationView } from '@dhc/contracts';
import { describe, expect, it } from 'vitest';
import { memoryStore } from './store';
import { VisitCache } from './visit-cache';

const view = (id: string, date: string) =>
  ({
    appointment: { id, date },
    consultation: null,
    vitals: null,
    canEdit: true,
  }) as unknown as ConsultationView;

describe('VisitCache', () => {
  it('keeps today’s opened visits and drops older days', async () => {
    let today = '2026-10-06';
    const store = memoryStore();
    const cache = new VisitCache(store, () => today);
    await cache.put(view('a1', '2026-10-06'), null);
    expect((await cache.get('a1'))?.view.appointment.id).toBe('a1');
    today = '2026-10-07';
    expect(await cache.get('a1')).toBeNull();
    await cache.put(view('a2', '2026-10-07'), null);
    expect(Object.keys(JSON.parse(store.data.get('clinic.visits')!))).toEqual(['a2']);
    await cache.clear();
    expect(store.data.size).toBe(0);
  });
});
