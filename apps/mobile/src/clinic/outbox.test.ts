import { describe, expect, it } from 'vitest';
import { Outbox, type OutboxItem, type SendOutcome } from './outbox';
import { memoryStore } from './store';

function setup() {
  let n = 0;
  const store = memoryStore();
  const box = new Outbox(
    store,
    () => `key-${++n}`,
    () => 1_000,
  );
  return { store, box };
}

const checkIn = (id: string, label = 'Asha Verma · 3') => ({
  kind: 'check_in' as const,
  method: 'POST' as const,
  path: `/appointments/${id}/actions`,
  body: { action: 'check_in' },
  label,
});

describe('Outbox', () => {
  it('keeps queued writes across restarts and sends them in order with their keys', async () => {
    const { store, box } = setup();
    await box.add(checkIn('a1'));
    await box.add(checkIn('a2'));

    const again = new Outbox(store, () => 'unused');
    await again.load();
    const sent: string[] = [];
    await again.flush(async (item) => {
      sent.push(`${item.id}:${item.path}`);
      return { kind: 'sent' };
    });
    expect(sent).toEqual(['key-1:/appointments/a1/actions', 'key-2:/appointments/a2/actions']);
    expect(again.getItems()).toEqual([]);
  });

  it('stops at a network failure and resumes from the same item, keeping its key', async () => {
    const { box } = setup();
    await box.add(checkIn('a1'));
    await box.add(checkIn('a2'));
    await box.flush(async () => ({ kind: 'retry' }));
    expect(box.getItems().map((i) => [i.id, i.attempts])).toEqual([
      ['key-1', 1],
      ['key-2', 0],
    ]);
    await box.flush(async () => {
      throw new TypeError('Network request failed');
    });
    expect(box.getItems()).toHaveLength(2);

    const keys: string[] = [];
    await box.flush(async (item) => {
      keys.push(item.id);
      return { kind: 'sent' };
    });
    expect(keys).toEqual(['key-1', 'key-2']);
  });

  it('marks a refused write failed with the reason and carries on with the rest', async () => {
    const { box } = setup();
    await box.add(checkIn('a1'));
    await box.add(checkIn('a2'));
    await box.flush(async (item): Promise<SendOutcome> =>
      item.path.includes('a1')
        ? { kind: 'rejected', message: 'This appointment is cancelled.' }
        : { kind: 'sent' },
    );
    expect(box.getItems()).toMatchObject([
      { id: 'key-1', status: 'failed', error: 'This appointment is cancelled.' },
    ]);
    await box.discard('key-1');
    expect(box.getItems()).toEqual([]);
  });

  it('keeps only the latest waiting notes for a visit, and shares one run between callers', async () => {
    const { box } = setup();
    const notes = (text: string) => ({
      kind: 'notes' as const,
      method: 'PUT' as const,
      path: '/appointments/a1/consultation',
      body: { text },
      label: 'Notes',
    });
    await box.add(notes('first'));
    await box.add(notes('second'));
    expect(box.getItems().map((i) => (i.body as { text: string }).text)).toEqual(['second']);

    let calls = 0;
    const send = async (_: OutboxItem): Promise<SendOutcome> => {
      calls += 1;
      return { kind: 'sent' };
    };
    await Promise.all([box.flush(send), box.flush(send)]);
    expect(calls).toBe(1);
  });

  it('clears everything on sign-out', async () => {
    const { store, box } = setup();
    await box.add(checkIn('a1'));
    await box.clear();
    expect(box.getItems()).toEqual([]);
    expect(store.data.size).toBe(0);
  });
});

describe('Outbox across a sign-out', () => {
  it('stops sending the previous person’s queue once it is cleared', async () => {
    const { store, box } = setup();
    await box.add(checkIn('a1'));
    await box.add(checkIn('a2'));
    const sent: string[] = [];
    let release: () => void = () => undefined;
    const flushing = box.flush(async (item) => {
      sent.push(item.path);
      await new Promise<void>((resolve) => (release = resolve));
      return { kind: 'sent' };
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await box.clear();
    release();
    await flushing;
    expect(sent).toEqual(['/appointments/a1/actions']);
    expect(box.getItems()).toEqual([]);
    expect(await store.get('clinic.outbox')).toBeNull();
  });

  it('does not bring back a queue whose read was still running at sign-out', async () => {
    const store = memoryStore();
    await store.set('clinic.outbox', [{ id: 'old', status: 'pending' }]);
    let release: () => void = () => undefined;
    const slow = {
      ...store,
      get: async <T>(key: string) => {
        await new Promise<void>((resolve) => (release = resolve));
        return store.get<T>(key);
      },
    };
    const box = new Outbox(slow, () => 'k');
    const loading = box.load();
    await box.clear();
    release();
    await loading;
    expect(box.getItems()).toEqual([]);
  });

  it('shares one read between concurrent callers, so a queued item is never hidden', async () => {
    const { store, box } = setup();
    await Promise.all([box.load(), box.add(checkIn('a1')), box.load()]);
    expect(box.getItems().map((i) => i.path)).toEqual(['/appointments/a1/actions']);
    expect(await store.get<OutboxItem[]>('clinic.outbox')).toHaveLength(1);
  });

  it('replays with the key the first attempt used, and drops a save a newer one replaced', async () => {
    const { box } = setup();
    await box.add(checkIn('a1'), 'first-attempt-key');
    expect(box.getItems()[0]?.id).toBe('first-attempt-key');
    await box.add({ ...checkIn('a2'), kind: 'notes', method: 'PUT', path: '/n' });
    await box.dropPending('notes', '/n');
    expect(box.getItems().map((i) => i.id)).toEqual(['first-attempt-key']);
  });
});

describe('Outbox while a save is being sent', () => {
  const notes = (revision: number, text: string) => ({
    kind: 'notes' as const,
    method: 'PUT' as const,
    path: '/appointments/a1/consultation',
    body: { notes: { plan: text }, followUpDate: null, revision },
    label: 'Notes',
  });

  it('keeps a newer save and moves it onto the revision the send left', async () => {
    const { box } = setup();
    await box.add(notes(3, 'first'));
    let release: () => void = () => undefined;
    const flushing = box.flush(async () => {
      await new Promise<void>((resolve) => (release = resolve));
      return { kind: 'sent', result: { revision: 4 } };
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await box.add(notes(3, 'second'));
    release();
    await flushing;
    expect(box.getItems().map((i) => i.body)).toEqual([
      { notes: { plan: 'second' }, followUpDate: null, revision: 4 },
    ]);
  });

  it('marks the one being sent failed when refused, and keeps the newer save', async () => {
    const { box } = setup();
    await box.add(notes(3, 'first'));
    let release: () => void = () => undefined;
    const flushing = box.flush(async () => {
      await new Promise<void>((resolve) => (release = resolve));
      return { kind: 'rejected', message: 'These notes were changed somewhere else.' };
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await box.add(notes(3, 'second'));
    release();
    await flushing;
    expect(box.getItems().map((i) => i.status)).toEqual(['failed', 'pending']);
  });
});
