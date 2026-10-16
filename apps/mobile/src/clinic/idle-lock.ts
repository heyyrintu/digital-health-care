/** Face ID, fingerprint or the device passcode reopens the Clinic app after this (build plan §7). */
export const IDLE_LOCK_MS = 15 * 60_000;

/**
 * When the Clinic app locks: after 15 minutes without a touch, counting time in the
 * background. Locking keeps the session; unlocking needs the device owner's biometrics or
 * passcode. Pure state so the timing can be tested off device.
 */
export class IdleLock {
  private lastActive: number;
  private locked = false;

  constructor(
    now: number,
    { locked = false, limitMs = IDLE_LOCK_MS }: { locked?: boolean; limitMs?: number } = {},
  ) {
    this.lastActive = now;
    this.locked = locked;
    this.limitMs = limitMs;
  }

  private readonly limitMs: number;

  get isLocked(): boolean {
    return this.locked;
  }

  /**
   * A touch or keypress. Ignored while locked; a touch after the limit has passed (before the
   * timer noticed) locks instead of extending the session. True if it just locked.
   */
  activity(now: number): boolean {
    if (this.check(now)) return true;
    if (!this.locked) this.lastActive = now;
    return false;
  }

  /** Call on a timer and when the app returns to the foreground; true if it just locked. */
  check(now: number): boolean {
    // A clock set back (now before the last touch) can't prove the device was attended: lock.
    const idle = now - this.lastActive;
    if (this.locked || (idle >= 0 && idle < this.limitMs)) return false;
    this.locked = true;
    return true;
  }

  unlock(now: number): void {
    this.locked = false;
    this.lastActive = now;
  }
}
