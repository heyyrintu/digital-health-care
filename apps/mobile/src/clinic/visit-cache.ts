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
  /** Writes run one after another, and clear() waits for them, so none outlives a sign-out. */
  private queue: Promise<void> = Promise.resolve();
  private generation = 0;

  constructor(
    private readonly store: KeyValueStore,
    private readonly today: () => string,
  ) {}

  async get(id: string): Promise<SavedVisit | null> {
    const all = (await this.store.get<Record<string, SavedVisit>>(KEY)) ?? {};
    const saved = all[id];
    return saved && saved.view.appointment.date === this.today() ? saved : null;
  }

  put(view: ConsultationView, chart: PatientChart | null): Promise<void> {
    const generation = this.generation;
    return this.serial(async () => {
      if (generation !== this.generation) return;
      const all = (await this.store.get<Record<string, SavedVisit>>(KEY)) ?? {};
      const today = this.today();
      const kept = Object.fromEntries(
        Object.entries(all).filter(([, v]) => v.view.appointment.date === today),
      );
      kept[view.appointment.id] = { view, chart };
      await this.store.set(KEY, kept);
    });
  }

  clear(): Promise<void> {
    this.generation += 1;
    return this.serial(() => this.store.remove(KEY));
  }

  private serial(task: () => Promise<void>): Promise<void> {
    const run = this.queue.then(task);
    this.queue = run.catch(() => undefined);
    return run;
  }
}
