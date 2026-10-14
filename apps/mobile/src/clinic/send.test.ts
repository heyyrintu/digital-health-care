import { ApiError } from '@dhc/api-client';
import { describe, expect, it } from 'vitest';
import type { OutboxItem } from './outbox';
import { newKey, outboxSender } from './send';

const item: OutboxItem = {
  id: 'key-1',
  kind: 'check_in',
  method: 'POST',
  path: '/appointments/a1/actions',
  body: { action: 'check_in' },
  label: 'Asha',
  createdAt: 0,
  attempts: 0,
  status: 'pending',
};

const apiError = (status: number) =>
  new ApiError(status, 'CONFLICT', 'This appointment is cancelled.', undefined);

describe('outboxSender', () => {
  it('sends with the item’s idempotency key', async () => {
    const calls: unknown[] = [];
    const send = outboxSender(async (method, path, options) => {
      calls.push([method, path, options.idempotencyKey, options.body]);
      return undefined;
    });
    expect(await send(item)).toEqual({ kind: 'sent' });
    expect(calls).toEqual([['POST', '/appointments/a1/actions', 'key-1', { action: 'check_in' }]]);
  });

  it('treats a refusal as final and everything else as try again', async () => {
    const failing = (error: unknown) =>
      outboxSender(async () => {
        throw error;
      });
    expect(await failing(apiError(409))(item)).toMatchObject({ kind: 'rejected' });
    for (const status of [401, 408, 429, 500, 503]) {
      expect(await failing(apiError(status))(item)).toEqual({ kind: 'retry' });
    }
    expect(await failing(new TypeError('Network request failed'))(item)).toEqual({ kind: 'retry' });
  });

  it('makes distinct keys', () => {
    expect(newKey()).not.toBe(newKey());
  });
});
