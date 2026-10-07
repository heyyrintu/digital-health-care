/**
 * UHID: per-organisation patient number, the clinic's prefix followed by a sequence
 * number with no separator or padding (PRD §5.4). Example: prefix `EK` from 10001 gives
 * `EK10001`. Imported patients keep their existing UHIDs, whatever their format.
 */
const PREFIX_PATTERN = /^[A-Z0-9]{0,8}$/;

export function formatUhid(prefix: string, sequence: number): string {
  if (!PREFIX_PATTERN.test(prefix)) {
    throw new Error('UHID prefix must be up to 8 uppercase letters or digits');
  }
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error('UHID sequence must be a positive integer');
  }
  return `${prefix}${sequence}`;
}
