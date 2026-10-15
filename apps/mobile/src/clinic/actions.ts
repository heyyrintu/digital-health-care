import { ApiError } from '@dhc/api-client';
import { AppointmentDetail, type Appointment } from '@dhc/contracts';
import type { QueueAction } from '@dhc/domain';
import type { ZodType } from 'zod';
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
    // A timeout or an unhealthy server may or may not have applied the check-in; the outbox
    // retries it with the same key, so it is applied once either way.
    const retryable = error instanceof ApiError && (error.status === 408 || error.status >= 500);
    if (action === 'check_in' && retryable) return queueCheckIn(a, body, key);
    if (!isNetworkError(error)) throw error;
    return action === 'check_in' ? queueCheckIn(a, body, key) : 'needs_connection';
  }
}

async function queueCheckIn(
  a: Appointment,
  body: { action: QueueAction; reason: null },
  key: string,
): Promise<ActionResult> {
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

/** Appointment IDs with a check-in waiting on this device. */
export function pendingCheckIns(items: readonly { kind: string; path: string; status: string }[]) {
  return new Set(
    items
      .filter((i) => i.kind === 'check_in' && i.status === 'pending')
      .map((i) => i.path.split('/')[2]!),
  );
}

/**
 * Saves a write the Clinic app may queue offline (ADR 0009: vitals and notes). Online it
 * returns the server's answer; without a network it is queued with its Idempotency-Key and
 * the later save of the same record replaces it. Server refusals are thrown.
 */
export async function saveOrQueue<T>(input: {
  kind: 'vitals' | 'notes';
  path: string;
  body: unknown;
  label: string;
  schema: ZodType<T>;
}): Promise<{ status: 'saved'; data: T } | { status: 'queued' }> {
  // One key for the attempt and its replay: a save that reached the server before the
  // network dropped is applied once.
  const key = newKey();
  try {
    const data = (await api.request('PUT', input.path, {
      schema: input.schema,
      body: input.body,
      idempotencyKey: key,
    })) as T;
    // An older save of this record still waiting on the device must not replay over this one.
    await outbox.dropPending(input.kind, input.path);
    return { status: 'saved', data };
  } catch (error) {
    if (!isNetworkError(error)) throw error;
    await outbox.add(
      {
        kind: input.kind,
        method: 'PUT',
        path: input.path,
        body: input.body,
        label: input.label,
      },
      key,
    );
    return { status: 'queued' };
  }
}

/** Doctors open the consultation once the patient has arrived (PRD §6.1), as on the web. */
export const canConsult = (a: Appointment, role: string) =>
  role === 'doctor' && ['checked_in', 'in_consultation', 'completed'].includes(a.status);
