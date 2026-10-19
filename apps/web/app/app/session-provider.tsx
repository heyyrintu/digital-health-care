'use client';

import { createApiClient, PatientAccount, type ApiClient } from '@dhc/api-client';
import type { MeResponse } from '@dhc/contracts';
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
import { sessionEndReason } from '../../lib/patient';
import { browserFileDeps, OpenFiles } from '../../lib/patient-files';
import {
  ACTIVITY_KEY,
  ACTIVITY_THROTTLE_MS,
  KEEP_KEY,
  SIGNED_OUT_KEY,
  REFRESH_LOCK,
  TAB_CHANNEL,
  acceptsSession,
  idleDelay,
  needsRefresh,
  parseActivity,
  parseTabMessage,
  refreshRetryDelay,
  restoreDecision,
  type TabMessage,
} from '../../lib/patient-session';
import {
  IDLE_TIMEOUT_MS,
  REFRESH_LEAD_MS,
  postPatientSession,
  refreshDelayMs,
  type SessionTokens,
} from '../../lib/session-client';

type Status = 'loading' | 'signedOut' | 'signedIn';
export type SignOutReason = 'user' | 'idle' | 'expired' | 'offline';

/** The privacy notice and terms of use the consents screen links to, when published. */
export type DocumentUrls = { privacy_notice?: string; terms?: string };

interface PatientSessionContext {
  status: Status;
  me: MeResponse | null;
  /** Why the last session ended, for a message on the sign-in page. */
  endedReason: SignOutReason | null;
  /** Sends the patient's access token; `api.portal*` are the portal's endpoints. */
  api: ApiClient;
  /** The API's base URL (public reads without the token, such as the clinic's branding). */
  apiBaseUrl: string;
  /** Onboarding step, the family and whose records are shown; reset on sign-out. */
  account: PatientAccount;
  /** The tabs and object URLs of files opened in this session; closed and revoked when it ends. */
  files: OpenFiles;
  documentUrls: DocumentUrls;
  /** In production without both documents published, consents cannot be accepted. */
  documentsMissing: boolean;
  locale: Locale;
  setLocale(locale: Locale): void;
  t(key: MessageKey, params?: Record<string, string | number>): string;
  /**
   * Called with the tokens returned by the portal's code route; `keep` is the patient's
   * "Keep me signed in on this device".
   */
  startSession(tokens: SessionTokens, options?: { keep?: boolean }): Promise<void>;
  signOut(reason?: SignOutReason): Promise<void>;
}

const Context = createContext<PatientSessionContext | null>(null);

const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
/** The language the patient picked last time on this browser (a convenience, not a secret). */
const LOCALE_KEY = 'dhc.patientLocale';

// localStorage can be missing or throw (private mode, blocked site data): every use is
// wrapped, and the portal works without it.
function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeStorage(key: string, value: string | null) {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Not remembered; the session still works in this tab.
  }
}

/**
 * Runs a refresh while holding the browser-wide refresh lock where the browser has one, so
 * two tabs never send the same single-use refresh token (which would count as reuse and end
 * the session). Without Web Locks it simply runs.
 */
function withRefreshLock<T>(run: () => Promise<T>): Promise<T> {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  return locks ? (locks.request(REFRESH_LOCK, run) as Promise<T>) : run();
}

/**
 * The restore-on-load refresh, shared by every mount until it settles. React's StrictMode
 * runs the mount effect twice in development; two refreshes with one refresh token would
 * count as reuse and end the session, so the replayed effect reuses this one.
 */
let restoring: Promise<SessionTokens> | null = null;

function restoreOnce(): Promise<SessionTokens> {
  restoring ??= withRefreshLock(() => postPatientSession<SessionTokens>('refresh')).finally(() => {
    restoring = null;
  });
  return restoring;
}

/**
 * Patient portal session (ADR 0015), separate from the staff and console sessions: the
 * refresh token is in its own httpOnly cookie behind `/api/patient-session/*` (gone when
 * the browser closes, unless the patient chose to stay signed in), and the access token
 * stays in memory. Only a patient session is accepted. Refreshes a minute before expiry, or
 * before a call when a sleeping tab missed that, one tab at a time. Signs out after 15
 * minutes without activity in any tab (not when kept on this device), when another tab
 * signs out, and when the API refuses the token.
 */
export function PatientSessionProvider({
  apiBaseUrl,
  documentUrls,
  documentsMissing,
  children,
}: {
  apiBaseUrl: string;
  documentUrls: DocumentUrls;
  documentsMissing: boolean;
  children: ReactNode;
}) {
  const accessToken = useRef<{ token: string; expiresAt: number } | null>(null);
  const refreshing = useRef<Promise<void> | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** Latest activity seen in any tab (ms since epoch), and when this tab last recorded its own. */
  const lastActivity = useRef(0);
  const lastRecorded = useRef(0);
  /** Whether the patient chose to stay signed in on this device. */
  const kept = useRef(false);
  const channel = useRef<BroadcastChannel | null>(null);
  /**
   * Bumped whenever the session ends: a refresh or sign-in still in flight from an earlier
   * session checks it and does not bring back a token or timer after sign-out.
   */
  const generation = useRef(0);
  const [status, setStatus] = useState<Status>('loading');
  const [me, setMe] = useState<MeResponse | null>(null);
  const [endedReason, setEndedReason] = useState<SignOutReason | null>(null);
  const [locale, setLocaleState] = useState<Locale>('en');

  useEffect(() => {
    const saved = readStorage(LOCALE_KEY);
    if (saved === 'en' || saved === 'hi') setLocaleState(saved);
  }, []);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    writeStorage(LOCALE_KEY, next);
  }, []);

  // Screen readers and spell-checkers follow the page language.
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const post = useCallback((message: TabMessage) => {
    try {
      channel.current?.postMessage(message);
    } catch {
      // The channel is closed (the page is going away).
    }
  }, []);

  // Set below, once the session's functions exist.
  const onRefused = useRef<(token: string) => void>(() => undefined);
  const refreshNow = useRef<() => Promise<void>>(async () => undefined);

  const api = useMemo(
    () =>
      createApiClient({
        baseUrl: apiBaseUrl,
        getAccessToken: async () => {
          const current = accessToken.current;
          if (!current) return null;
          // A tab that slept past the scheduled refresh renews before it calls.
          if (needsRefresh(current, Date.now())) {
            await refreshNow.current().catch(() => undefined);
          }
          return accessToken.current?.token ?? null;
        },
        fetch: async (input, init) => {
          const response = await globalThis.fetch(input, init);
          const sent = new Headers(init?.headers).get('authorization')?.slice(7);
          if (response.status === 401 && sent) onRefused.current(sent);
          return response;
        },
      }),
    [apiBaseUrl],
  );

  const account = useMemo(
    () =>
      new PatientAccount({
        consents: () => api.portalConsents(),
        patients: async () => (await api.portalPatients()).data,
      }),
    [api],
  );

  const files = useMemo(() => new OpenFiles(browserFileDeps()), []);

  const clear = useCallback(
    (reason: SignOutReason | null) => {
      generation.current += 1;
      // Prescriptions and results opened in this session go with it (threat model T24).
      files.closeAll();
      clearTimeout(refreshTimer.current);
      clearTimeout(idleTimer.current);
      accessToken.current = null;
      refreshing.current = null;
      kept.current = false;
      account.reset();
      setMe(null);
      setEndedReason(reason);
      setStatus('signedOut');
    },
    [account, files],
  );

  /** Holds a token and schedules its refresh. */
  const keep = useCallback((token: { token: string; expiresAt: number }) => {
    accessToken.current = token;
    clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(
      () => void refreshNow.current().catch(() => undefined),
      refreshDelayMs((token.expiresAt - Date.now()) / 1000),
    );
  }, []);

  const keepTokens = useCallback(
    (tokens: SessionTokens) => {
      const token = { token: tokens.accessToken, expiresAt: Date.now() + tokens.expiresIn * 1000 };
      keep(token);
      return token;
    },
    [keep],
  );

  /** Records activity in this tab, for every tab (at most every 15 seconds). */
  const recordActivity = useCallback(
    (now = Date.now()) => {
      lastActivity.current = Math.max(lastActivity.current, now);
      if (now - lastRecorded.current < ACTIVITY_THROTTLE_MS) return;
      lastRecorded.current = now;
      writeStorage(ACTIVITY_KEY, String(now));
      post({ type: 'activity', at: now });
    },
    [post],
  );

  /**
   * One refresh at a time in this tab, shared by the timer and any call that finds the
   * token stale, and one at a time across tabs (the lock). Inside the lock it checks again:
   * a token another tab refreshed meanwhile is used instead of refreshing twice.
   */
  const refresh = useCallback((): Promise<void> => {
    if (refreshing.current) return refreshing.current;
    const current = generation.current;
    const before = accessToken.current?.token;
    const attempt = async (n: number): Promise<void> => {
      try {
        const fresh = await withRefreshLock(async () => {
          const now = accessToken.current;
          if (now && now.token !== before && !needsRefresh(now, Date.now(), REFRESH_LEAD_MS)) {
            return null;
          }
          return postPatientSession<SessionTokens>('refresh');
        });
        if (generation.current !== current) return;
        if (fresh === null) {
          keep(accessToken.current!);
          return;
        }
        const token = keepTokens(fresh);
        post({ type: 'token', accessToken: token.token, expiresAt: token.expiresAt });
      } catch (e) {
        if (generation.current !== current) return;
        const delay = refreshRetryDelay(e, n);
        if (delay !== null) {
          await new Promise((resolve) => setTimeout(resolve, delay));
          return attempt(n + 1);
        }
        clear(sessionEndReason(e) ?? 'expired');
        throw e;
      }
    };
    const pending = attempt(0).finally(() => {
      if (refreshing.current === pending) refreshing.current = null;
    });
    refreshing.current = pending;
    return pending;
  }, [clear, keep, keepTokens, post]);

  const signOut = useCallback(
    async (reason: SignOutReason = 'user') => {
      const token = accessToken.current?.token;
      // Until the server confirms, the cookie may still be live: the next load finishes
      // this sign-out instead of restoring the session.
      writeStorage(SIGNED_OUT_KEY, '1');
      clear(reason);
      writeStorage(KEEP_KEY, null);
      // Every tab of this browser signs out with this one.
      post({ type: 'signedOut' });
      await postPatientSession('logout', undefined, token)
        .then(() => {
          writeStorage(SIGNED_OUT_KEY, null);
          writeStorage(ACTIVITY_KEY, null);
        })
        .catch(() => undefined);
    },
    [clear, post],
  );

  const startSession = useCallback(
    async (tokens: SessionTokens, options: { keep?: boolean } = {}) => {
      const current = generation.current;
      if (options.keep !== undefined) {
        // A new sign-in: any other tab still showing an earlier session signs out.
        post({ type: 'signedOut' });
        writeStorage(SIGNED_OUT_KEY, null);
        kept.current = options.keep;
        writeStorage(KEEP_KEY, options.keep ? '1' : null);
      } else {
        kept.current = readStorage(KEEP_KEY) === '1';
      }
      keepTokens(tokens);
      lastRecorded.current = 0;
      recordActivity();
      try {
        const signedIn = await api.me();
        if (generation.current !== current) return;
        if (!acceptsSession(signedIn)) {
          await signOut('expired');
          return;
        }
        setMe(signedIn);
        setEndedReason(null);
        setStatus('signedIn');
      } catch (e) {
        if (generation.current === current) clear(sessionEndReason(e) ?? 'expired');
      }
    },
    [api, clear, keepTokens, post, recordActivity, signOut],
  );

  // The API client reaches these through refs: it is made once, before them.
  useEffect(() => {
    refreshNow.current = refresh;
    // The API refused a token (revoked, or signed out elsewhere): this browser signs out
    // too, unless a refresh replaced that token meanwhile.
    onRefused.current = (token) => {
      if (accessToken.current?.token === token) void signOut('expired');
    };
  }, [refresh, signOut]);

  // The other tabs of this browser: their activity, fresh tokens and sign-outs.
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const tabs = new BroadcastChannel(TAB_CHANNEL);
    channel.current = tabs;
    tabs.onmessage = (event: MessageEvent) => {
      const message = parseTabMessage(event.data);
      if (!message) return;
      if (message.type === 'activity') {
        lastActivity.current = Math.max(lastActivity.current, message.at);
      } else if (message.type === 'signedOut') {
        if (accessToken.current) clear('user');
      } else if (accessToken.current && message.expiresAt > accessToken.current.expiresAt) {
        keep({ token: message.accessToken, expiresAt: message.expiresAt });
      }
    };
    return () => {
      channel.current = null;
      tabs.close();
    };
  }, [clear, keep]);

  // Restore a portal session from its cookie on first load (once, even under StrictMode),
  // unless no tab has been used for the idle period: then the session is ended instead.
  useEffect(() => {
    let mounted = true;
    // A sign-in (or sign-out) meanwhile wins over this restore, whenever it settles.
    const current = generation.current;
    const live = () => mounted && generation.current === current;
    const signedOut = readStorage(SIGNED_OUT_KEY) === '1';
    const decision = restoreDecision({
      lastActivity: parseActivity(readStorage(ACTIVITY_KEY)),
      kept: readStorage(KEEP_KEY) === '1',
      now: Date.now(),
      signedOut,
    });
    if (decision === 'end') {
      clear(signedOut ? 'user' : 'idle');
      // No access token here: the route ends the session with the cookie first. The records
      // go only once it has, so a failed call or a second mount meanwhile ends it again,
      // never restores.
      void postPatientSession('logout')
        .then(() => {
          writeStorage(SIGNED_OUT_KEY, null);
          writeStorage(ACTIVITY_KEY, null);
        })
        .catch(() => undefined);
    } else {
      restoreOnce()
        .then((tokens) => (live() ? startSession(tokens) : undefined))
        // No session (401) is not an ending worth a notice; an unreachable server is.
        .catch((e: unknown) => {
          if (live()) clear(sessionEndReason(e));
        });
    }
    return () => {
      mounted = false;
      clearTimeout(refreshTimer.current);
      clearTimeout(idleTimer.current);
    };
  }, [startSession, clear]);

  // Idle sign-out while signed in: after 15 minutes without activity in any tab.
  useEffect(() => {
    if (status !== 'signedIn' || kept.current) return;
    const check = () => {
      const delay = idleDelay({
        lastActivity: Math.max(lastActivity.current, parseActivity(readStorage(ACTIVITY_KEY)) ?? 0),
        kept: kept.current,
        now: Date.now(),
      });
      if (delay === null) return;
      if (delay > 0) idleTimer.current = setTimeout(check, delay);
      else void signOut('idle');
    };
    const onActivity = () => recordActivity();
    idleTimer.current = setTimeout(check, IDLE_TIMEOUT_MS);
    for (const event of ACTIVITY_EVENTS) {
      window.addEventListener(event, onActivity, { passive: true });
    }
    return () => {
      clearTimeout(idleTimer.current);
      for (const event of ACTIVITY_EVENTS) window.removeEventListener(event, onActivity);
    };
  }, [status, signOut, recordActivity]);

  const value = useMemo<PatientSessionContext>(
    () => ({
      status,
      me,
      endedReason,
      api,
      apiBaseUrl,
      account,
      files,
      documentUrls,
      documentsMissing,
      locale,
      setLocale,
      t: (key, params) => translate(locale, key, params),
      startSession,
      signOut,
    }),
    [
      status,
      me,
      endedReason,
      api,
      apiBaseUrl,
      account,
      files,
      documentUrls,
      documentsMissing,
      locale,
      setLocale,
      startSession,
      signOut,
    ],
  );

  return (
    <Context.Provider value={value}>
      <UiLocaleProvider locale={locale}>{children}</UiLocaleProvider>
    </Context.Provider>
  );
}

export function usePatientSession(): PatientSessionContext {
  const value = useContext(Context);
  if (!value) throw new Error('usePatientSession must be used inside PatientSessionProvider');
  return value;
}

export function PatientLocaleToggle() {
  const { locale, setLocale } = usePatientSession();
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
