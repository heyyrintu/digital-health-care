/**
 * Normalises an Indian mobile number to E.164 (`+91XXXXXXXXXX`). Accepts spaces,
 * dashes and a +91, 91 or 0 prefix. Returns null for anything else.
 */
export function normaliseIndianMobile(input: string): string | null {
  const digits = input.replace(/[\s\-()]/g, '');
  const match = /^(?:\+91|91|0)?([6-9]\d{9})$/.exec(digits);
  return match ? `+91${match[1]}` : null;
}
