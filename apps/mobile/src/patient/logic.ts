import type { Locale } from '@dhc/i18n';

const IST_OFFSET_MS = 330 * 60_000;

/** Today's date in India, `YYYY-MM-DD`. */
export function istToday(now: Date): string {
  return new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** `count` consecutive dates from `from`, never past the booking horizon. */
export function bookingDays(from: string, horizonDays: number, count = 14): string[] {
  const start = Date.parse(`${from}T00:00:00Z`);
  const days = Math.min(count, horizonDays + 1);
  return Array.from({ length: days }, (_, i) =>
    new Date(start + i * 86_400_000).toISOString().slice(0, 10),
  );
}

const LOCALE_TAG: Record<Locale, string> = { en: 'en-IN', hi: 'hi-IN' };

/** "Wed, 7 Oct" for a `YYYY-MM-DD` date. */
export function shortDate(date: string, locale: Locale): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(LOCALE_TAG[locale], {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

/** "₹800" from paise. */
export function rupees(paise: number, locale: Locale): string {
  return new Intl.NumberFormat(LOCALE_TAG[locale], {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: paise % 100 === 0 ? 0 : 2,
  }).format(paise / 100);
}

export type DayPart = 'morning' | 'afternoon' | 'evening';

/** Groups IST `HH:MM` slot times into morning (before 12), afternoon (before 17) and evening. */
export function dayPart(startTime: string): DayPart {
  const hour = Number(startTime.slice(0, 2));
  return hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
}

/** A real calendar date, not in the future and not before 1900. */
export function isValidDob(value: string, today: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value &&
    value <= today &&
    value >= '1900-01-01'
  );
}
