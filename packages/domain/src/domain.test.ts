import { describe, expect, it } from 'vitest';
import {
  ageFrom,
  formatInr,
  formatIstDateTime,
  formatUhid,
  istDateKey,
  rupeesToPaise,
} from './index';

describe('UHID', () => {
  it('joins the prefix and sequence without padding (PRD §5.4)', () => {
    expect(formatUhid('EK', 10001)).toBe('EK10001');
    expect(formatUhid('', 10001)).toBe('10001');
  });

  it('rejects invalid prefixes and sequences', () => {
    expect(() => formatUhid('ek', 1)).toThrow();
    expect(() => formatUhid('EK-', 1)).toThrow();
    expect(() => formatUhid('EK', 0)).toThrow();
    expect(() => formatUhid('EK', 1.5)).toThrow();
  });
});

describe('ageFrom', () => {
  it('counts completed years, and months for babies', () => {
    expect(ageFrom('1992-03-14', '2026-10-07')).toEqual({ years: 34, months: 414 });
    expect(ageFrom('1992-10-08', '2026-10-07').years).toBe(33);
    expect(ageFrom('2026-03-10', '2026-10-07')).toEqual({ years: 0, months: 6 });
    expect(ageFrom('2026-10-07', '2026-10-07')).toEqual({ years: 0, months: 0 });
  });
});

describe('IST time', () => {
  it('uses the IST calendar date, not UTC', () => {
    // 20:00 UTC on 6 Oct is 01:30 IST on 7 Oct.
    expect(istDateKey('2026-10-06T20:00:00Z')).toBe('2026-10-07');
    expect(istDateKey('2026-10-06T10:00:00Z')).toBe('2026-10-06');
  });

  it('formats a display time in IST', () => {
    expect(formatIstDateTime('2026-10-06T04:30:00Z')).toMatch(/6 Oct 2026.*10:00/);
  });

  it('rejects invalid dates', () => {
    expect(() => istDateKey('not a date')).toThrow();
  });
});

describe('money', () => {
  it('converts rupees to integer paise', () => {
    expect(rupeesToPaise(500)).toBe(50000);
    expect(rupeesToPaise(0.1 + 0.2)).toBe(30);
  });

  it('formats INR with Indian grouping', () => {
    expect(formatInr(12345600)).toBe('₹1,23,456');
    expect(formatInr(50050)).toBe('₹500.50');
  });

  it('rejects fractional or negative paise', () => {
    expect(() => formatInr(10.5)).toThrow();
    expect(() => formatInr(-1)).toThrow();
  });
});
