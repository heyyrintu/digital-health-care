'use client';

import { createApiClient, type ApiClient } from '@dhc/api-client';
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
import { retryableRefresh, sessionEndReason } from '../../lib/platform';
import {
  IDLE_TIMEOUT_MS,
  postPlatformSession,
  refreshDelayMs,
  type SessionTokens,
} from '../../lib/session-client';

type Status = 'loading' | 'signedOut' | 'signedIn';
export type SignOutReason = 'user' | 'idle' | 'expired' | 'network' | 'offline';

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
  /**
   * A new organisation's first-admin invite link, shown once (onboarding). Kept here, in
   * memory only, so moving between console pages does not lose it; signing out drops it.
   * While it is set the idle sign-out waits (at most IDLE_HOLD_MS) and the browser asks
   * before a reload or closing the tab.
   */
  handover: Handover | null;
  /**
   * Call before onboarding starts; the returned function shows its link, unless the session
   * ended meanwhile.
   */
  reserveHandover(): (handover: Handover) => void;
  dismissHandover(): void;
}

/** What the operator hands to a new organisation's first clinic admin. */
export interface Handover {
  organisation: string;
  admin: string;
  inviteUrl: string;
  expiresAt: string;
}

const Context = createContext<PlatformSessionContext | null>(null);

const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;

/** Longest the idle sign-out waits for a hold: an unattended screen still signs out. */
export const IDLE_HOLD_MS = 60 * 60_000;
/** A scheduled refresh the API never received (it was unreachable) is tried this many more times. */
const REFRESH_RETRIES = 2;
const REFRESH_RETRY_MS = 5_000;

/**
 * The restore-on-load refresh, shared by every mount until it settles. React's StrictMode
 * runs the mount effect twice in development; two refreshes with one refresh token would
 * count as reuse and end the session, so the replayed effect reuses this one.
 */
let restoring: Promise<SessionTokens> | null = null;

function restoreOnce(): Promise<SessionTokens> {
  restoring ??= postPlatformSession<SessionTokens>('refresh').finally(() => {
    restoring = null;
  });
  return restoring;
}

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
  /** While a hold is on: when it lapses (ms since epoch); 0 for none. */
  const idleHeldUntil = useRef(0);
  /**
   * Bumped whenever the session ends: a refresh or sign-in still in flight from an earlier
   * session checks it and does not bring back a token or timer after sign-out.
   */
  const generation = useRef(0);
  const [status, setStatus] = useState<Status>('loading');
  const [operator, setOperator] = useState<PlatformOperator | null>(null);
  const [endedReason, setEndedReason] = useState<SignOutReason | null>(null);
  const [locale, setLocale] = useState<Locale>('en');
  const [handover, setHandover] = useState<Handover | null>(null);

  // Screen readers and spell-checkers follow the page language.
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const api = useMemo(
    () => createApiClient({ baseUrl: apiBaseUrl, getAccessToken: () => accessToken.current }),
    [apiBaseUrl],
  );

  const clear = useCallback((reason: SignOutReason | null) => {
    generation.current += 1;
    clearTimeout(refreshTimer.current);
    clearTimeout(idleTimer.current);
    accessToken.current = null;
    setHandover(null);
    setOperator(null);
    setEndedReason(reason);
    setStatus('signedOut');
  }, []);

  const scheduleRefresh = useCallback(
    (expiresIn: number) => {
      clearTimeout(refreshTimer.current);
      const current = generation.current;
      const attempt = (retriesLeft: number) =>
        postPlatformSession<SessionTokens>('refresh')
          .then((tokens) => {
            if (generation.current !== current) return;
            accessToken.current = tokens.accessToken;
            scheduleRefresh(tokens.expiresIn);
          })
          .catch((e: unknown) => {
            if (generation.current !== current) return;
            // Only a refresh the API never received is safe to send again.
            if (retriesLeft > 0 && retryableRefresh(e)) {
              const delay = REFRESH_RETRY_MS * (REFRESH_RETRIES - retriesLeft + 1);
              refreshTimer.current = setTimeout(() => void attempt(retriesLeft - 1), delay);
            } else {
              clear(sessionEndReason(e) ?? 'expired');
            }
          });
      refreshTimer.current = setTimeout(
        () => void attempt(REFRESH_RETRIES),
        refreshDelayMs(expiresIn),
      );
    },
    [clear],
  );

  const startSession = useCallback(
    async (tokens: SessionTokens) => {
      const current = generation.current;
      accessToken.current = tokens.accessToken;
      scheduleRefresh(tokens.expiresIn);
      try {
        const { operator: signedIn } = await api.platform.me();
        if (generation.current !== current) return;
        setOperator(signedIn);
        setEndedReason(null);
        setStatus('signedIn');
      } catch (e) {
        if (generation.current === current) clear(sessionEndReason(e) ?? 'expired');
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

  // Restore a console session from its cookie on first load (once, even under StrictMode).
  useEffect(() => {
    let mounted = true;
    restoreOnce()
      .then((tokens) => (mounted ? startSession(tokens) : undefined))
      // No session (401) is not an ending worth a notice; outside the allowed networks is.
      .catch((e: unknown) => {
        if (mounted) clear(sessionEndReason(e));
      });
    return () => {
      mounted = false;
      clearTimeout(refreshTimer.current);
      clearTimeout(idleTimer.current);
    };
  }, [startSession, clear]);

  // Idle sign-out while signed in.
  useEffect(() => {
    if (status !== 'signedIn') return;
    // Fires after the idle period; while a hold is on, again exactly when the hold lapses.
    const expire = () => {
      const held = idleHeldUntil.current - Date.now();
      if (held > 0) idleTimer.current = setTimeout(expire, held);
      else void signOut('idle');
    };
    const reset = () => {
      clearTimeout(idleTimer.current);
      idleTimer.current = setTimeout(expire, IDLE_TIMEOUT_MS);
    };
    reset();
    for (const event of ACTIVITY_EVENTS) window.addEventListener(event, reset, { passive: true });
    return () => {
      clearTimeout(idleTimer.current);
      for (const event of ACTIVITY_EVENTS) window.removeEventListener(event, reset);
    };
  }, [status, signOut]);

  // While an invite link is on hand: hold off the idle sign-out, and ask before a reload or
  // closing the tab takes it away.
  useEffect(() => {
    if (!handover) return;
    idleHeldUntil.current = Date.now() + IDLE_HOLD_MS;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => {
      idleHeldUntil.current = 0;
      window.removeEventListener('beforeunload', warn);
    };
  }, [handover]);

  const dismissHandover = useCallback(() => setHandover(null), []);
  // Taken before onboarding starts: a link that arrives after the session ended is dropped,
  // so it cannot come back into a later session.
  const reserveHandover = useCallback(() => {
    const current = generation.current;
    return (shown: Handover) => {
      if (generation.current === current) setHandover(shown);
    };
  }, []);

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
      handover,
      reserveHandover,
      dismissHandover,
    }),
    [
      status,
      operator,
      endedReason,
      api,
      locale,
      startSession,
      signOut,
      handover,
      reserveHandover,
      dismissHandover,
    ],
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
