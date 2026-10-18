'use client';

import { t as translate, type Locale, type MessageKey } from '@dhc/i18n';
import { Button } from '@dhc/ui-web';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

type Translate = (key: MessageKey, params?: Record<string, string | number>) => string;

const HomeLocaleContext = createContext<{ locale: Locale; t: Translate }>({
  locale: 'en',
  t: (key, params) => translate('en', key, params),
});

/**
 * The home page's language: English, or Hindi from `?lang=hi` (read on the server) or the
 * toggle.
 */
export const useHomeLocale = () => useContext(HomeLocaleContext);

/**
 * The home page's language toggle and wrapper. The wrapper carries `lang`, so the page is
 * marked Hindi from the server's first byte for `?lang=hi`; the document's own `lang`
 * follows in the browser, as on the doctor page.
 */
export function HomeLocale({
  initialLocale,
  children,
}: {
  initialLocale: Locale;
  children: ReactNode;
}) {
  const [locale, setLocale] = useState<Locale>(initialLocale);
  const t: Translate = (key, params) => translate(locale, key, params);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  return (
    <HomeLocaleContext.Provider value={{ locale, t }}>
      <div lang={locale} className="mx-auto w-full max-w-3xl space-y-8">
        <div className="flex justify-end">
          <Button
            type="button"
            variant="outline"
            size="sm"
            lang={locale === 'en' ? 'hi' : 'en'}
            onClick={() => setLocale(locale === 'en' ? 'hi' : 'en')}
          >
            {locale === 'en' ? 'हिन्दी' : 'English'}
          </Button>
        </div>
        {children}
      </div>
    </HomeLocaleContext.Provider>
  );
}
