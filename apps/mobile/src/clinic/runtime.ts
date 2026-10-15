import { SyncMedicinesResponse, SyncTodayResponse } from '@dhc/contracts';
import { istDateKey } from '@dhc/domain';
import { api, session } from '../api';
import { fileStore } from './file-store';
import { MedicineCache } from './medicine-cache';
import { Outbox } from './outbox';
import { newKey, outboxSender } from './send';
import { TodayStore } from './today';
import { VisitCache } from './visit-cache';

/** Medicine changes are rare; the copy is refreshed at most this often. */
const MEDICINE_SYNC_MS = 6 * 60 * 60_000;

/** The Clinic app's offline state (ADR 0009), one per app run. */
export const outbox = new Outbox(fileStore, newKey);
export const today = new TodayStore(fileStore, () => istDateKey(new Date()));
export const medicines = new MedicineCache(fileStore);
export const visits = new VisitCache(fileStore, () => istDateKey(new Date()));

const send = outboxSender((method, path, options) => api.request(method, path, options));

let loaded: Promise<void> | null = null;
/** The last sign-out's clean-up; the next session's first read waits for it. */
let clearing: Promise<void> = Promise.resolve();

/**
 * The body of a notes or vitals save still on this device for `path`, if any: waiting, or
 * refused by the server (kept so the doctor can fix it rather than lose it).
 */
export function waitingBody<T>(kind: 'notes' | 'vitals', path: string): T | null {
  const item = [...outbox.getItems()].reverse().find((i) => i.kind === kind && i.path === path);
  return item ? (item.body as T) : null;
}

/**
 * Clears every store, trying a failed one once more. Rejects when one still fails, so the
 * next session reads nothing rather than what the last person left behind.
 */
async function clearAll(): Promise<void> {
  const stores = [outbox, today, medicines, visits];
  const results = await Promise.allSettled(stores.map((s) => s.clear()));
  const failed = stores.filter((_, i) => results[i]?.status === 'rejected');
  await Promise.all(failed.map((s) => s.clear()));
}

/**
 * Reads what this device saved, once. Rejects while the last sign-out's clean-up keeps
 * failing; each later call tries that clean-up again first.
 */
export function loadOffline(): Promise<void> {
  loaded ??= clearing
    .catch(() => (clearing = clearAll()))
    .then(() => Promise.all([outbox.load(), today.load(), medicines.load()]))
    .then(
      () => undefined,
      (error: unknown) => {
        loaded = null;
        throw error;
      },
    );
  return loaded;
}

/**
 * One round: fetch today's queue; when the server answers, send what was queued offline
 * and fetch again so the screen shows the result; then the medicine copy for doctors.
 */
export async function syncNow(messageOf: (error: unknown) => string): Promise<void> {
  // The last person's data could not be cleared yet: touch nothing until it is.
  if (
    !(await loadOffline().then(
      () => true,
      () => false,
    ))
  )
    return;
  const state = session.getState();
  if (state.status !== 'signed_in') return;
  const fetchToday = () => api.request('GET', '/sync/today', { schema: SyncTodayResponse });
  if (!(await today.refresh(fetchToday, messageOf))) return;
  if (outbox.getItems().some((i) => i.status === 'pending')) {
    await outbox.flush(send);
    await today.refresh(fetchToday, messageOf);
  }
  if (
    state.me.role === 'doctor' &&
    (medicines.syncedAt === null || Date.now() - medicines.syncedAt > MEDICINE_SYNC_MS)
  ) {
    await medicines
      .sync((cursor) =>
        api.request('GET', '/sync/medicines', {
          schema: SyncMedicinesResponse,
          query: { cursor },
        }),
      )
      .catch(() => undefined);
  }
}

// What one person saved or queued is never shown to, or sent as, the next person to sign
// in on a shared device. Cleared whenever the app reaches signed-out: after a sign-out, an
// expired or revoked session, and also on a launch whose saved session is gone or can't be
// read, since the app may have been killed before an earlier clean-up finished.
let wasSignedOut = false;
function onSession() {
  const signedOut = session.getState().status === 'signed_out';
  if (signedOut && !wasSignedOut) {
    // Kept, not fire-and-forget: a late delete must not remove what the next person writes.
    clearing = clearAll();
    // Handled by the next loadOffline(), which tries again; not an unhandled rejection.
    clearing.catch(() => undefined);
    loaded = null;
  }
  wasSignedOut = signedOut;
}
// Also checked now: the session may have reached signed-out before this module loaded.
onSession();
session.subscribe(onSession);
