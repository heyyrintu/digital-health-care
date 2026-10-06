import { en, type MessageKey } from './en';
import { hi } from './hi';

export type Locale = 'en' | 'hi';
export type { MessageKey };

export const LOCALES: readonly Locale[] = ['en', 'hi'];
export const DEFAULT_LOCALE: Locale = 'en';

export const messages: Record<Locale, Record<MessageKey, string>> = { en, hi };

/** Translate a key, filling `{placeholders}`. Missing params are left visible, never blank. */
export function t(
  locale: Locale,
  key: MessageKey,
  params: Record<string, string | number> = {},
): string {
  const template = messages[locale][key] ?? messages[DEFAULT_LOCALE][key];
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
}

/** Placeholder names used by a message, for parity checks between locales. */
export function placeholdersOf(template: string): string[] {
  return [...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();
}
