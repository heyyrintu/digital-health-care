import { withAuth, withPlatform } from '@dhc/db';
import type { Services } from '../../services';

/** Retain expired challenges for 24 hours; audits remain in the audit log. */
export async function purgeAccountSecurityChallenges(s: Services) {
  const cutoff = new Date(s.now().getTime() - 24 * 60 * 60_000);
  for (const run of [withAuth, withPlatform]) {
    await run(
      s.db,
      (tx) => tx.$executeRaw`
      DELETE FROM account_security_challenges WHERE id IN (
        SELECT id FROM account_security_challenges WHERE expires_at < ${cutoff}
        ORDER BY expires_at LIMIT 1000 FOR UPDATE SKIP LOCKED
      )`,
    );
  }
}

export function scheduleAccountSecurityPurge(s: Services, log: { warn(message: string): void }) {
  let active: Promise<unknown> | undefined;
  const tick = () => {
    if (active) return;
    active = purgeAccountSecurityChallenges(s)
      .catch(() => log.warn('Account security challenge cleanup unavailable; will retry'))
      .finally(() => {
        active = undefined;
      });
  };
  const timer = setInterval(tick, 60 * 60_000);
  timer.unref();
  tick();
  return async () => {
    clearInterval(timer);
    await active;
  };
}
