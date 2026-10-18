import { describe, expect, it } from 'vitest';
import { dayPart, istToday, rupees } from './logic';

describe('patient app helpers', () => {
  it('takes today in India, not UTC', () => {
    // 20:00 UTC on 6 Oct is 01:30 on 7 Oct in India.
    expect(istToday(new Date('2026-10-06T20:00:00Z'))).toBe('2026-10-07');
  });

  it('formats fees for India', () => {
    expect(rupees(80000, 'en')).toBe('₹800');
    expect(rupees(12550, 'en')).toBe('₹125.50');
  });

  it('groups slots by part of the day', () => {
    expect(['09:30', '12:00', '16:59', '17:00'].map(dayPart)).toEqual([
      'morning',
      'afternoon',
      'afternoon',
      'evening',
    ]);
  });
});
