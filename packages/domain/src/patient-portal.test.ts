import { describe, expect, it } from 'vitest';
import { bookingDays, isAdult, isValidDob, shortDate } from './patient-portal';

describe('patient portal helpers', () => {
  it('offers days up to the booking horizon', () => {
    expect(bookingDays('2026-10-30', 30, 3)).toEqual(['2026-10-30', '2026-10-31', '2026-11-01']);
    expect(bookingDays('2026-10-06', 2)).toHaveLength(3);
    expect(bookingDays('2026-10-06', 0)).toEqual(['2026-10-06']);
  });

  it('formats dates for India', () => {
    expect(shortDate('2026-10-07', 'en')).toBe('Wed, 7 Oct');
  });

  it('checks dates of birth', () => {
    expect(isValidDob('1997-11-23', '2026-10-07')).toBe(true);
    expect(isAdult('2008-10-07', '2026-10-07')).toBe(true);
    expect(isAdult('2008-10-08', '2026-10-07')).toBe(false);
    expect(isValidDob('2026-02-30', '2026-10-07')).toBe(false);
    expect(isValidDob('2027-01-01', '2026-10-07')).toBe(false);
    expect(isValidDob('23/11/1997', '2026-10-07')).toBe(false);
    expect(isValidDob('1896-01-01', '2026-10-07')).toBe(true);
    expect(isValidDob('1895-12-31', '2026-10-07')).toBe(false);
    expect(isValidDob('2026-10-07', '2026-10-07')).toBe(true);
  });
});
