'use client';

import { ApiError, createApiClient, type ApiClient } from '@dhc/api-client';
import type { PlatformOperator } from '@dhc/contracts';
import { t as translate, type Locale, type MessageKey } from '@dhc/i18n';
import { Button, UiLocaleProvider } from '@dhc/ui-web';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  IDLE_TIMEOUT_MS,
  postPlatformSession,
  refreshDelayMs,
  type SessionTokens,
} from '../../lib/session-client';

type Status = 'loading' | 'signedOut' | 'signedIn';
export type SignOutReason = 'user' | 'idle' | 'expired';

interface PlatformSessionContext {
  status: Status;
  operator: PlatformOperator | null;
  /** Why the last session ended, for a message on the sign-in page. */
  endedReason: SignOutReason | null;
  /** Sends the platform access token only; `api.platform.*` are the console's endpoints. */
  api: ApiClient;
  locale: Locale;
  setLocale(locale: Locale): void;
  t(key: MessageKey, params?: Record<string, string | number>): string;
  /** Called with the tokens returned by the console's sign-in route. */
  startSession(tokens: SessionTokens): Promise<void>;
  signOut(reason?: SignOutReason): Promise<void>;
}

const Context = createContext<PlatformSessionContext | null>(null);

const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;

/**
 * Platform console session (ADR 0016), separate from the clinic's: its refresh token is in
 * its own httpOnly cookie behind `/api/platform-session/*`, and the access token stays in
 * this provider's memory. A clinic session is never read here, and this one never reaches
 * the clinic pages. Refreshes a minute before expiry; signs out after 15 minutes idle.
 */
export function PlatformSessionProvider({
  apiBaseUrl,
  children,
}: {
  apiBaseUrl: string;
  children: ReactNode;
}) {
  const accessToken = useRef<string | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [status, setStatus] = useState<Status>('loading');
  const [operator, setOperator] = useState<PlatformOperator | null>(null);
  const [endedReason, setEndedReason] = useState<SignOutReason | null>(null);
  const [locale, setLocale] = useState<Locale>('en');

  // Screen readers and spell-checkers follow the page language.
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const api = useMemo(
    () => createApiClient({ baseUrl: apiBaseUrl, getAccessToken: () => accessToken.current }),
    [apiBaseUrl],
  );

  const clear = useCallback((reason: SignOutReason | null) => {
    clearTimeout(refreshTimer.current);
    clearTimeout(idleTimer.current);
    accessToken.current = null;
    setOperator(null);
    setEndedReason(reason);
    setStatus('signedOut');
  }, []);

  const scheduleRefresh = useCallback(
    (expiresIn: number) => {
      clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(() => {
        postPlatformSession<SessionTokens>('refresh')
          .then((tokens) => {
            accessToken.current = tokens.accessToken;
            scheduleRefresh(tokens.expiresIn);
          })
          .catch(() => clear('expired'));
      }, refreshDelayMs(expiresIn));
    },
    [clear],
  );

  const startSession = useCallback(
    async (tokens: SessionTokens) => {
      accessToken.current = tokens.accessToken;
      scheduleRefresh(tokens.expiresIn);
      try {
        setOperator((await api.platform.me()).operator);
        setEndedReason(null);
        setStatus('signedIn');
      } catch {
        clear('expired');
      }
    },
    [api, clear, scheduleRefresh],
  );

  const signOut = useCallback(
    async (reason: SignOutReason = 'user') => {
      const token = accessToken.current ?? undefined;
      clear(reason);
      await postPlatformSession('logout', undefined, token).catch(() => undefined);
    },
    [clear],
  );

  // Restore a console session from its cookie on first load.
  useEffect(() => {
    postPlatformSession<SessionTokens>('refresh')
      .then(startSession)
      .catch((e: unknown) => clear(e instanceof ApiError && e.status === 401 ? null : 'expired'));
    return () => {
      clearTimeout(refreshTimer.current);
      clearTimeout(idleTimer.current);
    };
  }, [startSession, clear]);

  // Idle sign-out while signed in.
  useEffect(() => {
    if (status !== 'signedIn') return;
    const reset = () => {
      clearTimeout(idleTimer.current);
      idleTimer.current = setTimeout(() => void signOut('idle'), IDLE_TIMEOUT_MS);
    };
    reset();
    for (const event of ACTIVITY_EVENTS) window.addEventListener(event, reset, { passive: true });
    return () => {
      clearTimeout(idleTimer.current);
      for (const event of ACTIVITY_EVENTS) window.removeEventListener(event, reset);
    };
  }, [status, signOut]);

  const value = useMemo<PlatformSessionContext>(
    () => ({
      status,
      operator,
      endedReason,
      api,
      locale,
      setLocale,
      t: (key, params) => translate(locale, key, params),
      startSession,
      signOut,
    }),
    [status, operator, endedReason, api, locale, startSession, signOut],
  );

  return (
    <Context.Provider value={value}>
      <UiLocaleProvider locale={locale}>{children}</UiLocaleProvider>
    </Context.Provider>
  );
}

export function usePlatformSession(): PlatformSessionContext {
  const value = useContext(Context);
  if (!value) throw new Error('usePlatformSession must be used inside PlatformSessionProvider');
  return value;
}

export function PlatformLocaleToggle() {
  const { locale, setLocale } = usePlatformSession();
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={() => setLocale(locale === 'en' ? 'hi' : 'en')}
      lang={locale === 'en' ? 'hi' : 'en'}
    >
      {locale === 'en' ? 'हिंदी' : 'English'}
    </Button>
  );
}
