import type { Locale } from '@dhc/i18n';

/**
 * Patient app helpers. Those the web portal shares (booking days, dates, date-of-birth
 * checks) live in `@dhc/domain`.
 */

const IST_OFFSET_MS = 330 * 60_000;

/** Today's date in India, `YYYY-MM-DD`. */
export function istToday(now: Date): string {
  return new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

const LOCALE_TAG: Record<Locale, string> = { en: 'en-IN', hi: 'hi-IN' };

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
