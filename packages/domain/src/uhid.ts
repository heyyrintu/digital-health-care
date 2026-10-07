/**
 * UHID: per-organisation patient number built from the clinic's prefix and a sequence
 * (UHID settings: prefix + start number). Example: `GC-000123`.
 */
export interface UhidSettings {
  prefix: string;
  /** Digits the sequence is zero-padded to. */
  padTo: number;
}

const PREFIX_PATTERN = /^[A-Z][A-Z0-9]{0,7}$/;

export function formatUhid(settings: UhidSettings, sequence: number): string {
  if (!PREFIX_PATTERN.test(settings.prefix)) {
    throw new Error('UHID prefix must be 1-8 uppercase letters or digits, starting with a letter');
  }
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error('UHID sequence must be a positive integer');
  }
  return `${settings.prefix}-${String(sequence).padStart(settings.padTo, '0')}`;
}

export function parseUhid(uhid: string): { prefix: string; sequence: number } | null {
  const match = /^([A-Z][A-Z0-9]{0,7})-(\d+)$/.exec(uhid.trim().toUpperCase());
  if (!match) return null;
  const sequence = Number(match[2]);
  if (!Number.isSafeInteger(sequence) || sequence < 1) return null;
  return { prefix: match[1]!, sequence };
}
