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

/** Reads what this device saved, once. */
export function loadOffline(): Promise<void> {
  loaded ??= Promise.all([outbox.load(), today.load(), medicines.load()]).then(() => undefined);
  return loaded;
}

/**
 * One round: fetch today's queue; when the server answers, send what was queued offline
 * and fetch again so the screen shows the result; then the medicine copy for doctors.
 */
export async function syncNow(messageOf: (error: unknown) => string): Promise<void> {
  await loadOffline();
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
// in on a shared device.
let wasSignedIn = session.getState().status === 'signed_in';
session.subscribe(() => {
  const signedIn = session.getState().status === 'signed_in';
  if (wasSignedIn && !signedIn) {
    void Promise.all([outbox.clear(), today.clear(), medicines.clear(), visits.clear()]);
  }
  wasSignedIn = signedIn;
});
