import { DEFAULT_LOCALE, LOCALES, type Locale } from '@dhc/i18n';

/** The first of the device's preferred languages the apps are translated into. */
export function pickLocale(languageCodes: readonly (string | null | undefined)[]): Locale {
  for (const code of languageCodes) {
    const base = code?.toLowerCase().split(/[-_]/)[0];
    const match = LOCALES.find((locale) => locale === base);
    if (match) return match;
  }
  return DEFAULT_LOCALE;
}
