import { describe, expect, it } from 'vitest';
import { nextIstMidnight } from '../src/sse';

describe('nextIstMidnight', () => {
  it('is the coming midnight in India, not UTC', () => {
    // 23:00 IST on 6 Oct is 17:30 UTC; midnight IST on 7 Oct is 18:30 UTC on 6 Oct.
    expect(nextIstMidnight(new Date(Date.UTC(2026, 9, 6, 17, 30)))).toBe(
      Date.UTC(2026, 9, 6, 18, 30),
    );
    // 00:30 IST on 7 Oct (19:00 UTC on 6 Oct) rolls over at midnight IST on 8 Oct.
    expect(nextIstMidnight(new Date(Date.UTC(2026, 9, 6, 19, 0)))).toBe(
      Date.UTC(2026, 9, 7, 18, 30),
    );
  });

  it('moves to the next day when it is exactly midnight', () => {
    const midnight = Date.UTC(2026, 9, 6, 18, 30);
    expect(nextIstMidnight(new Date(midnight))).toBe(midnight + 86_400_000);
  });
});
