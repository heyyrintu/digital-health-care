'use client';

import { DEFAULT_LOCALE, t, type Locale, type MessageKey } from '@dhc/i18n';
import { createContext, useContext, useMemo, type ReactNode } from 'react';

const LocaleContext = createContext<Locale>(DEFAULT_LOCALE);

/** Sets the language for the components' own text (labels, screen-reader text). */
export function UiLocaleProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;
}

export function useUiLocale(): Locale {
  return useContext(LocaleContext);
}

/** Translator bound to the current UI locale. */
export function useT() {
  const locale = useContext(LocaleContext);
  return useMemo(
    () => (key: MessageKey, params?: Record<string, string | number>) => t(locale, key, params),
    [locale],
  );
}
