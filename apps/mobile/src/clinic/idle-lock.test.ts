import { describe, expect, it } from 'vitest';
import { IDLE_LOCK_MS, IdleLock } from './idle-lock';

describe('IdleLock', () => {
  it('locks after 15 minutes without activity, including time in the background', () => {
    const lock = new IdleLock(0);
    lock.activity(60_000);
    expect(lock.check(60_000 + IDLE_LOCK_MS - 1)).toBe(false);
    expect(lock.check(60_000 + IDLE_LOCK_MS)).toBe(true);
    expect(lock.isLocked).toBe(true);
    // Touches while locked do not count; only an unlock does.
    lock.activity(60_000 + IDLE_LOCK_MS + 5);
    expect(lock.check(60_000 + IDLE_LOCK_MS + 10)).toBe(false);
    expect(lock.isLocked).toBe(true);
    lock.unlock(2 * IDLE_LOCK_MS);
    expect(lock.isLocked).toBe(false);
    expect(lock.check(3 * IDLE_LOCK_MS - 1)).toBe(false);
  });
});

describe('IdleLock on launch', () => {
  it('can start locked, for an app opened on a saved session', () => {
    const lock = new IdleLock(0, { locked: true });
    expect(lock.isLocked).toBe(true);
    lock.unlock(10);
    expect(lock.isLocked).toBe(false);
  });
});
