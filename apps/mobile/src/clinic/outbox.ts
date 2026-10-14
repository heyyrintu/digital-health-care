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
  private loaded = false;
  private flushing: Promise<void> | null = null;
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

  async load(): Promise<void> {
    if (this.loaded) return;
    this.items = (await this.store.get<OutboxItem[]>(KEY)) ?? [];
    this.loaded = true;
    this.emit();
  }

  async add(
    item: Pick<OutboxItem, 'kind' | 'method' | 'path' | 'body' | 'label'>,
  ): Promise<OutboxItem> {
    await this.load();
    const full: OutboxItem = {
      ...item,
      id: this.newId(),
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
    this.items = this.items.filter((i) => i.id !== id);
    await this.save();
  }

  /** Signing out clears what this person queued: it must not be sent as someone else. */
  async clear(): Promise<void> {
    this.items = [];
    await this.store.remove(KEY);
    this.emit();
  }

  private async run(send: Sender): Promise<void> {
    await this.load();
    for (const item of [...this.items]) {
      if (item.status !== 'pending') continue;
      item.attempts += 1;
      let outcome: SendOutcome;
      try {
        outcome = await send(item);
      } catch {
        outcome = { kind: 'retry' };
      }
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
