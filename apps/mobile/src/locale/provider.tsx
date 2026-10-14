import { t as translate, type Locale, type MessageKey } from '@dhc/i18n';
import { getLocales } from 'expo-localization';
import * as SecureStore from 'expo-secure-store';
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
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

  // A choice made before the saved one is read wins over it.
  const chosen = useRef(false);
  useEffect(() => {
    void SecureStore.getItemAsync(LOCALE_KEY).then((saved) => {
      if (!chosen.current && (saved === 'en' || saved === 'hi')) setLocaleState(saved);
    });
  }, []);

  const value = useMemo<LocaleContextValue>(
    () => ({
      locale,
      setLocale: (next) => {
        chosen.current = true;
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
