import { describe, expect, it } from 'vitest';
import {
  formatInr,
  formatIstDateTime,
  formatUhid,
  istDateKey,
  parseUhid,
  rupeesToPaise,
} from './index';

describe('UHID', () => {
  it('formats with prefix and padding', () => {
    expect(formatUhid({ prefix: 'GC', padTo: 6 }, 123)).toBe('GC-000123');
  });

  it('does not truncate sequences longer than the padding', () => {
    expect(formatUhid({ prefix: 'GC', padTo: 3 }, 12345)).toBe('GC-12345');
  });

  it('rejects invalid prefixes and sequences', () => {
    expect(() => formatUhid({ prefix: 'gc', padTo: 6 }, 1)).toThrow();
    expect(() => formatUhid({ prefix: 'GC', padTo: 6 }, 0)).toThrow();
    expect(() => formatUhid({ prefix: 'GC', padTo: 6 }, 1.5)).toThrow();
  });

  it('round-trips through parse, case-insensitively', () => {
    expect(parseUhid(' gc-000123 ')).toEqual({ prefix: 'GC', sequence: 123 });
    expect(parseUhid('GC000123')).toBeNull();
    expect(parseUhid('GC-0')).toBeNull();
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
