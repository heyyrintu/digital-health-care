import { describe, expect, it } from 'vitest';
import { bookingDays, dayPart, istToday, isValidDob, rupees, shortDate } from './logic';

describe('patient app helpers', () => {
  it('takes today in India, not UTC', () => {
    // 20:00 UTC on 6 Oct is 01:30 on 7 Oct in India.
    expect(istToday(new Date('2026-10-06T20:00:00Z'))).toBe('2026-10-07');
  });

  it('offers days up to the booking horizon', () => {
    expect(bookingDays('2026-10-30', 30, 3)).toEqual(['2026-10-30', '2026-10-31', '2026-11-01']);
    expect(bookingDays('2026-10-06', 2)).toHaveLength(3);
  });

  it('formats dates and fees for India', () => {
    expect(shortDate('2026-10-07', 'en')).toBe('Wed, 7 Oct');
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

  it('checks dates of birth', () => {
    expect(isValidDob('1997-11-23', '2026-10-07')).toBe(true);
    expect(isValidDob('2026-02-30', '2026-10-07')).toBe(false);
    expect(isValidDob('2027-01-01', '2026-10-07')).toBe(false);
    expect(isValidDob('23/11/1997', '2026-10-07')).toBe(false);
  });
});
