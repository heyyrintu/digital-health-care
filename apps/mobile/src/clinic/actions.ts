import { AppointmentDetail, type Appointment } from '@dhc/contracts';
import type { QueueAction } from '@dhc/domain';
import { api } from '../api';
import { outbox } from './runtime';
import { newKey } from './send';
import { isNetworkError } from './today';

export type ActionResult = 'done' | 'queued' | 'needs_connection';

/**
 * Runs a queue action. Check-in is the one that can wait for the network (ADR 0009): it is
 * saved on the device and sent with the same Idempotency-Key when the connection is back.
 * Everything else needs the server now. Server refusals are thrown for the screen to show.
 */
export async function runAction(a: Appointment, action: QueueAction): Promise<ActionResult> {
  const key = newKey();
  const body = { action, reason: null };
  try {
    await api.request('POST', `/appointments/${a.id}/actions`, {
      schema: AppointmentDetail,
      body,
      idempotencyKey: key,
    });
    return 'done';
  } catch (error) {
    if (!isNetworkError(error)) throw error;
    if (action !== 'check_in') return 'needs_connection';
    await outbox.add(
      {
        kind: 'check_in',
        method: 'POST',
        path: `/appointments/${a.id}/actions`,
        body,
        label: `${a.patient.name} · ${a.tokenNumber}`,
      },
      key,
    );
    return 'queued';
  }
}

/** Appointment IDs with a check-in waiting on this device. */
export function pendingCheckIns(items: readonly { kind: string; path: string; status: string }[]) {
  return new Set(
    items
      .filter((i) => i.kind === 'check_in' && i.status === 'pending')
      .map((i) => i.path.split('/')[2]!),
  );
}
