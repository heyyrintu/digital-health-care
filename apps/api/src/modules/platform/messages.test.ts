import { describe, expect, it } from 'vitest';
import { LOCKED } from '../auth/service';
import { MFA_EXPIRED } from './auth';

/**
 * The web console (`apps/web/lib/platform.ts`) words two refusals by the API's message:
 * the 15-minute lockout (a 429 like the per-address rate limit) and the expired code step
 * (a 401 like a wrong code). Rewording either must change the console too.
 */
describe('messages the platform console depends on', () => {
  it('keeps the lockout and expired-step wording', () => {
    expect(LOCKED().message).toBe('Too many attempts. Try again in 15 minutes.');
    expect(MFA_EXPIRED().message).toBe('Your sign-in has expired. Start again.');
  });
});
