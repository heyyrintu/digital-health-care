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

  /** A touch or keypress. Ignored while locked. */
  activity(now: number): void {
    if (!this.locked) this.lastActive = now;
  }

  /** Call on a timer and when the app returns to the foreground; true if it just locked. */
  check(now: number): boolean {
    if (this.locked || now - this.lastActive < this.limitMs) return false;
    this.locked = true;
    return true;
  }

  unlock(now: number): void {
    this.locked = false;
    this.lastActive = now;
  }
}
