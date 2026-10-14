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
    if (!isNetworkError(error)) throw error;
    if (action !== 'check_in') return 'needs_connection';
    await outbox.add({
      kind: 'check_in',
      method: 'POST',
      path: `/appointments/${a.id}/actions`,
      body,
      label: `${a.patient.name} · ${a.tokenNumber}`,
    });
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
  try {
    const data = (await api.request('PUT', input.path, {
      schema: input.schema,
      body: input.body,
      idempotencyKey: newKey(),
    })) as T;
    return { status: 'saved', data };
  } catch (error) {
    if (!isNetworkError(error)) throw error;
    await outbox.add({
      kind: input.kind,
      method: 'PUT',
      path: input.path,
      body: input.body,
      label: input.label,
    });
    return { status: 'queued' };
  }
}

/** Doctors open the consultation once the patient has arrived (PRD §6.1), as on the web. */
export const canConsult = (a: Appointment, role: string) =>
  role === 'doctor' && ['checked_in', 'in_consultation', 'completed'].includes(a.status);
