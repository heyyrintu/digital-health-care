import { describe, expect, it } from 'vitest';
import { bookingDays, isAdult, isValidDob, prescriptionPdfName, shortDate } from './patient-portal';

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

describe('prescriptionPdfName', () => {
  it('names the file after the number and version', () => {
    expect(prescriptionPdfName('SG-00042', 2)).toBe('SG-00042-v2.pdf');
  });

  it('keeps the name inside the cache folder and free of odd characters', () => {
    expect(prescriptionPdfName('../../etc/passwd', 1)).toBe('etc-passwd-v1.pdf');
    expect(prescriptionPdfName('RX 12/ä?*', 3)).toBe('RX-12-v3.pdf');
    expect(prescriptionPdfName('a\\b:c', 1)).toBe('a-b-c-v1.pdf');
  });

  it('falls back when nothing usable is left, and caps the length', () => {
    expect(prescriptionPdfName('/// ', 1)).toBe('prescription-v1.pdf');
    expect(prescriptionPdfName('', 1)).toBe('prescription-v1.pdf');
    expect(prescriptionPdfName('A'.repeat(200), 1)).toBe(`${'A'.repeat(60)}-v1.pdf`);
  });

  it('never writes a version that is not a positive whole number', () => {
    expect(prescriptionPdfName('SG-1', 0)).toBe('SG-1-v1.pdf');
    expect(prescriptionPdfName('SG-1', Number.NaN)).toBe('SG-1-v1.pdf');
    expect(prescriptionPdfName('SG-1', 1.5)).toBe('SG-1-v1.pdf');
  });
});
