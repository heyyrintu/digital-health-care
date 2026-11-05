import type { Job } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import { publishReceipts, receiptProcessor } from './whatsapp-status';

const id = '12345678-1234-4234-8234-123456789abc';
describe('durable receipt processing', () => {
  it('publishes IDs only, and reports failures so a later lease can retry', async () => {
    const claim = vi.fn().mockResolvedValue([{ id }]);
    const publish = vi
      .fn()
      .mockRejectedValueOnce(new Error('Redis unavailable'))
      .mockResolvedValue(undefined);
    await expect(publishReceipts(claim, publish)).rejects.toThrow();
    await publishReceipts(claim, publish);
    expect(publish.mock.calls).toEqual([[id], [id]]);
  });
  it('validates job kind and rejects unexpected data before processing', async () => {
    const process = vi.fn();
    const run = receiptProcessor(process);
    await run({ name: 'whatsapp-status', data: { eventId: id } } as Job);
    expect(process).toHaveBeenCalledExactlyOnceWith(id);
    await expect(run({ name: 'other', data: { eventId: id } } as Job)).rejects.toThrow();
    await expect(
      run({ name: 'whatsapp-status', data: { eventId: id, phone: 'not-allowed' } } as Job),
    ).rejects.toThrow();
    await expect(
      run({ name: 'whatsapp-status', data: { eventId: 'bad' } } as Job),
    ).rejects.toThrow();
    expect(process).toHaveBeenCalledOnce();
  });
});
