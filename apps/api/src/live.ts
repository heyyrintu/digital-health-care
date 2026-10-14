import { Client } from 'pg';

/** A visit whose queue card or waiting-room token changed. IDs only, never patient data. */
export interface QueueChange {
  organisationId: string;
  clinicId: string;
  /** The visit's IST day, `YYYY-MM-DD`. */
  date: string;
  appointmentId: string;
}

type Listener = (change: QueueChange) => void;

const CHANNEL = 'dhc_queue';
const RETRY_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

/**
 * Fans out the database's `dhc_queue` notifications (see the live_queue migration) to the
 * open queue and waiting-room streams. One Postgres connection per API process, opened
 * on the first subscriber and kept open with reconnects; every API process gets every
 * change, so it works behind a load balancer.
 */
export class LiveEvents {
  private readonly listeners = new Map<string, Set<Listener>>();
  private client: Client | null = null;
  private connecting: Promise<void> | null = null;
  private attempt = 0;
  private closed = false;

  constructor(private readonly databaseUrl: string) {}

  /** Calls `listener` for each change to the organisation's visits on `date`. */
  async subscribe(organisationId: string, date: string, listener: Listener): Promise<() => void> {
    const key = `${organisationId}:${date}`;
    let set = this.listeners.get(key);
    if (!set) this.listeners.set(key, (set = new Set()));
    set.add(listener);
    const unsubscribe = () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(key);
    };
    try {
      await this.ensureConnected();
    } catch (error) {
      unsubscribe();
      throw error;
    }
    return unsubscribe;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.listeners.clear();
    const client = this.client;
    this.client = null;
    await client?.end().catch(() => undefined);
  }

  private ensureConnected(): Promise<void> {
    if (this.client || this.closed) return Promise.resolve();
    this.connecting ??= this.connect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async connect(): Promise<void> {
    const client = new Client({ connectionString: this.databaseUrl });
    client.on('notification', (msg) => {
      if (msg.channel !== CHANNEL || !msg.payload) return;
      const change = parse(msg.payload);
      if (!change) return;
      for (const listener of this.listeners.get(`${change.organisationId}:${change.date}`) ?? []) {
        listener(change);
      }
    });
    client.on('error', () => this.reconnect(client));
    client.on('end', () => this.reconnect(client));
    try {
      await client.connect();
      await client.query(`LISTEN ${CHANNEL}`);
    } catch (error) {
      await client.end().catch(() => undefined);
      throw error;
    }
    if (this.closed) {
      await client.end();
      return;
    }
    this.client = client;
    this.attempt = 0;
  }

  private reconnect(dead: Client) {
    if (this.client !== dead) return;
    this.client = null;
    if (this.closed || this.listeners.size === 0) return;
    const delay = RETRY_MS[Math.min(this.attempt++, RETRY_MS.length - 1)]!;
    setTimeout(() => void this.ensureConnected().catch(() => this.retryLater()), delay).unref();
  }

  private retryLater() {
    if (this.closed) return;
    const delay = RETRY_MS[Math.min(this.attempt++, RETRY_MS.length - 1)]!;
    setTimeout(() => void this.ensureConnected().catch(() => this.retryLater()), delay).unref();
  }
}

function parse(payload: string): QueueChange | null {
  try {
    const raw = JSON.parse(payload) as { o?: unknown; c?: unknown; d?: unknown; a?: unknown };
    if (
      typeof raw.o !== 'string' ||
      typeof raw.c !== 'string' ||
      typeof raw.d !== 'string' ||
      typeof raw.a !== 'string'
    ) {
      return null;
    }
    return { organisationId: raw.o, clinicId: raw.c, date: raw.d, appointmentId: raw.a };
  } catch {
    return null;
  }
}
