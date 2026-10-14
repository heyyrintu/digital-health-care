import { ApiError } from '@dhc/api-client';
import { z } from 'zod';
import type { OutboxItem, SendOutcome } from './outbox';

type Request = (
  method: 'POST' | 'PUT',
  path: string,
  options: { schema: z.ZodType; body: unknown; idempotencyKey: string },
) => Promise<unknown>;

/**
 * Sends one queued write with its Idempotency-Key. The server refusing it (a 4xx other than
 * sign-in, timeouts and rate limits) is final and shown to the person with the reason;
 * anything else waits for the next try.
 */
export function outboxSender(request: Request) {
  return async (item: OutboxItem): Promise<SendOutcome> => {
    try {
      const result = await request(item.method, item.path, {
        schema: z.unknown(),
        body: item.body,
        idempotencyKey: item.id,
      });
      return { kind: 'sent', result };
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.status >= 400 &&
        error.status < 500 &&
        ![401, 408, 429].includes(error.status)
      ) {
        return { kind: 'rejected', message: error.message };
      }
      return { kind: 'retry' };
    }
  };
}

/** Unique enough for an idempotency key; not a secret. */
export function newKey(): string {
  const native = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto?.randomUUID;
  if (native) return native.call(globalThis.crypto);
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}
