import type { KeyValueStore } from './store';

/**
 * Writes the Clinic app may make without a network (ADR 0009): check-in, vitals, notes,
 * tags and counter payments. Signing, booking and online payments need a connection.
 */
export type OutboxKind = 'check_in' | 'vitals' | 'notes' | 'tags' | 'payment';

export interface OutboxItem {
  /** Also the Idempotency-Key, so a replay after a lost reply is applied once. */
  id: string;
  kind: OutboxKind;
  method: 'POST' | 'PUT';
  path: string;
  body: unknown;
  /** What the person sees in "waiting to sync", e.g. the patient's name and token. */
  label: string;
  createdAt: number;
  attempts: number;
  status: 'pending' | 'failed';
  /** For a failed item: the server's explanation, shown with the fix. */
  error?: string;
}

/** What sending one item came to. */
export type SendOutcome =
  | { kind: 'sent' }
  /** The network is down or the server is unhealthy: stop and try again later. */
  | { kind: 'retry' }
  /** The server refused it (e.g. the visit was cancelled meanwhile): keep it for the person. */
  | { kind: 'rejected'; message: string };

export type Sender = (item: OutboxItem) => Promise<SendOutcome>;

const KEY = 'clinic.outbox';

/**
 * Queued writes, kept across restarts and sent in order. A refused write never blocks the
 * rest: it is marked failed with the server's reason for the person to fix or discard.
 */
export class Outbox {
  private items: OutboxItem[] = [];
  private loading: Promise<void> | null = null;
  private flushing: Promise<void> | null = null;
  /** Bumped by clear(): work started before a sign-out must not touch what comes after. */
  private generation = 0;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly store: KeyValueStore,
    private readonly newId: () => string,
    private readonly now: () => number = Date.now,
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getItems = (): readonly OutboxItem[] => this.items;

  /** Reads the saved queue once; concurrent callers share the read. */
  load(): Promise<void> {
    this.loading ??= this.read();
    return this.loading;
  }

  private async read(): Promise<void> {
    const generation = this.generation;
    const saved = (await this.store.get<OutboxItem[]>(KEY)) ?? [];
    if (generation !== this.generation) return;
    this.items = saved;
    this.emit();
  }

  /**
   * Queues a write. `id` is the Idempotency-Key the first attempt already used, so a request
   * that reached the server before the network dropped is applied once when it is replayed.
   */
  async add(
    item: Pick<OutboxItem, 'kind' | 'method' | 'path' | 'body' | 'label'>,
    id: string = this.newId(),
  ): Promise<OutboxItem> {
    await this.load();
    const full: OutboxItem = {
      ...item,
      id,
      createdAt: this.now(),
      attempts: 0,
      status: 'pending',
    };
    // A later save of the same notes or vitals replaces the waiting one; it holds the latest.
    if (item.kind === 'notes' || item.kind === 'vitals' || item.kind === 'tags') {
      this.items = this.items.filter(
        (i) => !(i.status === 'pending' && i.kind === item.kind && i.path === item.path),
      );
    }
    this.items = [...this.items, full];
    await this.save();
    return full;
  }

  /** Sends pending items in order; concurrent calls share one run. */
  flush(send: Sender): Promise<void> {
    this.flushing ??= this.run(send).finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  async discard(id: string): Promise<void> {
    await this.load();
    this.items = this.items.filter((i) => i.id !== id);
    await this.save();
  }

  /** A newer save reached the server: an older one still waiting here must not replay. */
  async dropPending(kind: OutboxKind, path: string): Promise<void> {
    await this.load();
    const kept = this.items.filter(
      (i) => !(i.status === 'pending' && i.kind === kind && i.path === path),
    );
    if (kept.length === this.items.length) return;
    this.items = kept;
    await this.save();
  }

  /** Signing out clears what this person queued: it must not be sent as someone else. */
  async clear(): Promise<void> {
    this.generation += 1;
    this.items = [];
    this.loading = Promise.resolve();
    await this.store.remove(KEY);
    this.emit();
  }

  private async run(send: Sender): Promise<void> {
    await this.load();
    const generation = this.generation;
    for (const item of [...this.items]) {
      if (generation !== this.generation) return;
      if (item.status !== 'pending') continue;
      item.attempts += 1;
      let outcome: SendOutcome;
      try {
        outcome = await send(item);
      } catch {
        outcome = { kind: 'retry' };
      }
      if (generation !== this.generation) return;
      if (outcome.kind === 'retry') {
        await this.save();
        return;
      }
      if (outcome.kind === 'sent') {
        this.items = this.items.filter((i) => i.id !== item.id);
      } else {
        this.items = this.items.map((i) =>
          i.id === item.id ? { ...i, status: 'failed', error: outcome.message } : i,
        );
      }
      await this.save();
    }
  }

  private async save(): Promise<void> {
    await this.store.set(KEY, this.items);
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
