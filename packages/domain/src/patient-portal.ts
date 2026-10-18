import type { DisplayLocale } from './time';

/**
 * Pure helpers shared by the patient's screens on the web portal and in the Patient app
 * (PRD §4). Dates are IST calendar dates, `YYYY-MM-DD`.
 */

/** `count` consecutive dates from `from`, never past the booking horizon. */
export function bookingDays(from: string, horizonDays: number, count = 14): string[] {
  const start = Date.parse(`${from}T00:00:00Z`);
  const days = Math.max(0, Math.min(count, horizonDays + 1));
  return Array.from({ length: days }, (_, i) =>
    new Date(start + i * 86_400_000).toISOString().slice(0, 10),
  );
}

const LOCALE_TAG: Record<DisplayLocale, string> = { en: 'en-IN', hi: 'hi-IN' };

/** "Wed, 7 Oct" for a `YYYY-MM-DD` date. */
export function shortDate(date: string, locale: DisplayLocale): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(LOCALE_TAG[locale], {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

/** 18 or older on `today` (both `YYYY-MM-DD`), as the API decides who may be a guardian. */
export function isAdult(dob: string, today: string): boolean {
  return dob <= `${Number(today.slice(0, 4)) - 18}${today.slice(4)}`;
}

/** A real calendar date, not in the future and at most 130 years back, as the API allows. */
export function isValidDob(value: string, today: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value &&
    value <= today &&
    value >= `${Number(today.slice(0, 4)) - 130}-01-01`
  );
}

/**
 * A safe file name for a prescription PDF, e.g. `SG-00042-v2.pdf`: the number with anything
 * but letters, digits, `-` and `_` turned into `-`, so it can never leave a folder or trip a
 * viewer app. The share sheet and the browser's download show it, so it says which
 * prescription and version.
 */
export function prescriptionPdfName(number: string, version: number): string {
  const base =
    number
      .replace(/[^A-Za-z0-9_-]+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^[-_]+|[-_]+$/g, '')
      .slice(0, 60) || 'prescription';
  const v = Number.isInteger(version) && version > 0 ? version : 1;
  return `${base}-v${v}.pdf`;
}
