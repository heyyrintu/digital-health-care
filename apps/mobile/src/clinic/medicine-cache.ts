import type { SyncMedicine, SyncMedicinesResponse } from '@dhc/contracts';
import type { KeyValueStore } from './store';

const KEY = 'clinic.medicines';

interface Saved {
  cursor: string | null;
  medicines: Record<string, SyncMedicine>;
  aliases: { name: string; medicineId: string }[];
  syncedAt: number | null;
}

export type FetchMedicines = (cursor: string | undefined) => Promise<SyncMedicinesResponse>;

/**
 * The doctor's offline copy of the medicine master (ADR 0009): a full download once, then
 * only what changed since the stored cursor (`GET /sync/medicines`). Inactive medicines are
 * dropped; search covers names, generics, compositions and the clinic's linked names.
 */
export class MedicineCache {
  private saved: Saved = { cursor: null, medicines: {}, aliases: [], syncedAt: null };
  /** Bumped by clear(): a sync started before a sign-out never writes its result. */
  private generation = 0;
  private syncing: Promise<void> | null = null;

  constructor(
    private readonly store: KeyValueStore,
    private readonly now: () => number = Date.now,
  ) {}

  async load(): Promise<void> {
    const generation = this.generation;
    const saved = await this.store.get<Saved>(KEY);
    if (saved && generation === this.generation) this.saved = saved;
  }

  get syncedAt(): number | null {
    return this.saved.syncedAt;
  }

  get size(): number {
    return Object.keys(this.saved.medicines).length;
  }

  /**
   * Pulls every page of changes. A failure keeps what was saved before it. A sync asked for
   * while one runs shares it, so two runs never start from the same copy and overwrite each
   * other.
   */
  sync(fetch: FetchMedicines): Promise<void> {
    this.syncing ??= this.pull(fetch).finally(() => {
      this.syncing = null;
    });
    return this.syncing;
  }

  private async pull(fetch: FetchMedicines): Promise<void> {
    const generation = this.generation;
    let { cursor } = this.saved;
    const medicines = { ...this.saved.medicines };
    let aliases: Saved['aliases'] | undefined;
    for (;;) {
      const page = await fetch(cursor ?? undefined);
      for (const m of page.data) {
        if (m.active) medicines[m.id] = m;
        else delete medicines[m.id];
      }
      aliases = page.aliases;
      cursor = page.cursor;
      if (!page.hasMore) break;
    }
    if (generation !== this.generation) return;
    const next = { cursor, medicines, aliases: aliases ?? [], syncedAt: this.now() };
    await this.store.set(KEY, next);
    // Signed out while saving: the copy just written belongs to the previous person.
    if (generation !== this.generation) {
      await this.store.remove(KEY);
      return;
    }
    this.saved = next;
  }

  /** Offline search, two characters or more, as the online search: up to 20 by name. */
  search(query: string): SyncMedicine[] {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    const viaAlias = new Set(
      this.saved.aliases.filter((a) => a.name.toLowerCase().includes(q)).map((a) => a.medicineId),
    );
    return Object.values(this.saved.medicines)
      .filter(
        (m) =>
          viaAlias.has(m.id) ||
          m.name.toLowerCase().includes(q) ||
          m.genericName.toLowerCase().includes(q) ||
          m.composition.toLowerCase().includes(q),
      )
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 20);
  }

  async clear(): Promise<void> {
    this.generation += 1;
    this.saved = { cursor: null, medicines: {}, aliases: [], syncedAt: null };
    await this.store.remove(KEY);
  }
}
