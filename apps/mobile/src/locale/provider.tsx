import { t as translate, type Locale, type MessageKey } from '@dhc/i18n';
import { getLocales } from 'expo-localization';
import * as SecureStore from 'expo-secure-store';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { pickLocale } from './pick';

const LOCALE_KEY = 'dhc.locale';

interface LocaleContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: MessageKey, params?: Record<string, string | number>) => string;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

/** The device language by default; a choice made in the app is remembered. */
export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() =>
    pickLocale(getLocales().map((l) => l.languageCode)),
  );

  useEffect(() => {
    void SecureStore.getItemAsync(LOCALE_KEY).then((saved) => {
      if (saved === 'en' || saved === 'hi') setLocaleState(saved);
    });
  }, []);

  const value = useMemo<LocaleContextValue>(
    () => ({
      locale,
      setLocale: (next) => {
        setLocaleState(next);
        void SecureStore.setItemAsync(LOCALE_KEY, next);
      },
      t: (key, params) => translate(locale, key, params),
    }),
    [locale],
  );
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleContextValue {
  const value = useContext(LocaleContext);
  if (!value) throw new Error('useLocale needs a LocaleProvider');
  return value;
}
