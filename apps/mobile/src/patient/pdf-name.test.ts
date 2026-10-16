import { describe, expect, it } from 'vitest';
import { prescriptionPdfName } from './pdf-name';

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
