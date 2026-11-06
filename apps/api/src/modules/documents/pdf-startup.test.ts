import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkPdfStartup } from './pdf-startup';

afterEach(() => vi.useRealTimers());

describe('PDF startup sample', () => {
  it('recovers from a transient cold-start timeout', async () => {
    vi.useFakeTimers();
    const check = vi.fn().mockResolvedValueOnce('not_a_document: timeout').mockResolvedValue(null);
    const retry = vi.fn();
    const result = checkPdfStartup(check, retry);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toBeNull();
    expect(check).toHaveBeenCalledTimes(2);
    expect(retry).toHaveBeenCalledWith(1);
  });

  it('still fails after three timeouts and never loops indefinitely', async () => {
    vi.useFakeTimers();
    const check = vi.fn().mockResolvedValue('not_a_document: timeout');
    const retry = vi.fn();
    const result = checkPdfStartup(check, retry);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await result).toBe('not_a_document: timeout');
    expect(check).toHaveBeenCalledTimes(3);
    expect(retry).toHaveBeenCalledTimes(2);
  });

  it('returns permanent failures immediately', async () => {
    const check = vi.fn().mockResolvedValue('unavailable: worker could not start');
    const retry = vi.fn();
    expect(await checkPdfStartup(check, retry)).toBe('unavailable: worker could not start');
    expect(check).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
  });
});
