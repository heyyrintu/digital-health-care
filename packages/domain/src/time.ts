/** Dates are stored in UTC and shown in IST (Build Plan 4.3). */
export const CLINIC_TIME_ZONE = 'Asia/Kolkata';

export type DisplayLocale = 'en' | 'hi';

const INTL_LOCALE: Record<DisplayLocale, string> = { en: 'en-IN', hi: 'hi-IN' };

export function formatIstDateTime(value: Date | string, locale: DisplayLocale = 'en'): string {
  return new Intl.DateTimeFormat(INTL_LOCALE[locale], {
    timeZone: CLINIC_TIME_ZONE,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(toDate(value));
}

/** Calendar date in IST as `YYYY-MM-DD` — the "today" a clinic's queue belongs to. */
export function istDateKey(value: Date | string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: CLINIC_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(toDate(value));
  const get = (type: string) => parts.find((p) => p.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function toDate(value: Date | string): Date {
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) throw new Error('Invalid date');
  return date;
}
