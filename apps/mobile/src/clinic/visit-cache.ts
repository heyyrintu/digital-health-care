import type { ConsultationView, PatientChart } from '@dhc/contracts';
import type { KeyValueStore } from './store';

const KEY = 'clinic.visits';

/** A visit as last opened, with the patient's chart (allergies matter most offline). */
export interface SavedVisit {
  view: ConsultationView;
  chart: PatientChart | null;
}

/**
 * Today's opened visits and their charts (ADR 0009 "opened summaries"), so a doctor can keep writing notes
 * when the network drops. Only today's are kept; signing out deletes them.
 */
export class VisitCache {
  constructor(
    private readonly store: KeyValueStore,
    private readonly today: () => string,
  ) {}

  async get(id: string): Promise<SavedVisit | null> {
    const all = (await this.store.get<Record<string, SavedVisit>>(KEY)) ?? {};
    const saved = all[id];
    return saved && saved.view.appointment.date === this.today() ? saved : null;
  }

  async put(view: ConsultationView, chart: PatientChart | null): Promise<void> {
    const all = (await this.store.get<Record<string, SavedVisit>>(KEY)) ?? {};
    const today = this.today();
    const kept = Object.fromEntries(
      Object.entries(all).filter(([, v]) => v.view.appointment.date === today),
    );
    kept[view.appointment.id] = { view, chart };
    await this.store.set(KEY, kept);
  }

  async clear(): Promise<void> {
    await this.store.remove(KEY);
  }
}
