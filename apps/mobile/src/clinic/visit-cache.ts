import type { ConsultationView } from '@dhc/contracts';
import type { KeyValueStore } from './store';

const KEY = 'clinic.visits';

/**
 * Today's opened visits (ADR 0009 "opened summaries"), so a doctor can keep writing notes
 * when the network drops. Only today's are kept; signing out deletes them.
 */
export class VisitCache {
  constructor(
    private readonly store: KeyValueStore,
    private readonly today: () => string,
  ) {}

  async get(id: string): Promise<ConsultationView | null> {
    const all = (await this.store.get<Record<string, ConsultationView>>(KEY)) ?? {};
    const view = all[id];
    return view && view.appointment.date === this.today() ? view : null;
  }

  async put(view: ConsultationView): Promise<void> {
    const all = (await this.store.get<Record<string, ConsultationView>>(KEY)) ?? {};
    const today = this.today();
    const kept = Object.fromEntries(
      Object.entries(all).filter(([, v]) => v.appointment.date === today),
    );
    kept[view.appointment.id] = view;
    await this.store.set(KEY, kept);
  }

  async clear(): Promise<void> {
    await this.store.remove(KEY);
  }
}
