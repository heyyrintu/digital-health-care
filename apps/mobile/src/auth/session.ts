import type { MeResponse, TokenResponse } from '@dhc/contracts';

/** What survives an app restart; kept in the device keychain or keystore (vault.ts). */
export interface StoredSession {
  organisation: string;
  refreshToken: string;
}

export interface TokenVault {
  load(): Promise<StoredSession | null>;
  save(session: StoredSession): Promise<void>;
  clear(): Promise<void>;
}

/** The calls the session needs; each takes the token explicitly so none of them recurse. */
export interface SessionApi {
  refresh(refreshToken: string): Promise<TokenResponse>;
  me(accessToken: string): Promise<MeResponse>;
  logout(accessToken: string): Promise<void>;
}

export type SignedOutReason = 'expired' | 'signed_out';

export type SessionState =
  | { status: 'loading' }
  | { status: 'signed_out'; reason?: SignedOutReason }
  /** A saved session could not be checked (no network); the person can retry. */
  | { status: 'unreachable' }
  | { status: 'signed_in'; me: MeResponse };

/** Refresh this long before the access token expires. */
export const REFRESH_LEAD_MS = 60_000;

/** True when the API rejected the token itself, as opposed to the network failing. */
export function isAuthFailure(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return status === 401 || status === 403;
}

/**
 * The signed-in session on this device. Access tokens stay in memory; the refresh token,
 * which is single use, lives in the vault and is rotated on every refresh. Concurrent callers
 * share one refresh, so a burst of requests never spends the same refresh token twice.
 */
export class SessionManager {
  private state: SessionState = { status: 'loading' };
  private readonly listeners = new Set<() => void>();
  private access: { token: string; expiresAt: number } | null = null;
  private stored: StoredSession | null = null;
  private refreshing: Promise<string | null> | null = null;
  /** Bumped whenever a session starts or ends, so late work from an earlier one is dropped. */
  private generation = 0;

  constructor(
    private readonly vault: TokenVault,
    private readonly api: SessionApi,
    private readonly now: () => number = Date.now,
  ) {}

  getState = (): SessionState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** On launch: resume a saved session if its refresh token still works. */
  async restore(): Promise<void> {
    this.setState({ status: 'loading' });
    try {
      this.stored = await this.vault.load();
    } catch {
      // The keychain could not be read: start from sign-in rather than wait forever.
      this.stored = null;
    }
    if (!this.stored) return this.setState({ status: 'signed_out' });
    try {
      const token = await this.refreshOnce();
      if (!token) return;
      this.setState({ status: 'signed_in', me: await this.api.me(token) });
    } catch (error) {
      if (isAuthFailure(error)) await this.end('expired');
      else this.setState({ status: 'unreachable' });
    }
  }

  /** After the OTP or authenticator step: keep the tokens and load who signed in. */
  async signIn(organisation: string, tokens: TokenResponse): Promise<void> {
    const generation = ++this.generation;
    // Who signed in first: if that fails nothing is kept, so the screen and the session agree.
    const me = await this.api.me(tokens.accessToken);
    const stored = { organisation, refreshToken: tokens.refreshToken };
    await this.vault.save(stored);
    // Started over (or another sign-in) while this one was in flight: it does not win, and
    // what it saved goes unless a newer sign-in has replaced it.
    if (generation !== this.generation) {
      if (!this.stored) await this.vault.clear().catch(() => undefined);
      return;
    }
    this.stored = stored;
    this.keepAccess(tokens);
    this.setState({ status: 'signed_in', me });
  }

  /** A current access token, refreshed first when it is about to expire; null when signed out. */
  async getAccessToken(): Promise<string | null> {
    if (this.access && this.now() < this.access.expiresAt - REFRESH_LEAD_MS) {
      return this.access.token;
    }
    if (!this.stored) return null;
    try {
      return await this.refreshOnce();
    } catch (error) {
      if (isAuthFailure(error)) await this.end('expired');
      throw error;
    }
  }

  /**
   * The API said the session is gone (signed out elsewhere, or by a clinic admin). `token` is
   * the one the refused request carried: a late answer to a previous session's request does
   * not end the current one.
   */
  async expire(token?: string): Promise<void> {
    if (token && this.access && token !== this.access.token) return;
    if (this.state.status === 'signed_in') await this.end('expired');
  }

  async signOut(): Promise<void> {
    const access = this.access;
    const stored = this.stored;
    await this.end('signed_out');
    // Best effort, after the local session is gone: end the server one too, refreshing first
    // when the access token has run out so the refresh token does not outlive the sign-out.
    try {
      let token = access && this.now() < access.expiresAt ? access.token : null;
      if (!token && stored) token = (await this.api.refresh(stored.refreshToken)).accessToken;
      if (token) await this.api.logout(token);
    } catch {
      // Offline: the server session times out on its own.
    }
  }

  /** The organisation of the saved session, to prefill the clinic ID after sign-out. */
  get organisation(): string | undefined {
    return this.stored?.organisation;
  }

  private refreshOnce(): Promise<string | null> {
    this.refreshing ??= this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async doRefresh(): Promise<string | null> {
    const stored = this.stored;
    if (!stored) return null;
    const tokens = await this.api.refresh(stored.refreshToken);
    // Signed out while the refresh was in flight: drop the new tokens.
    if (this.stored !== stored) return null;
    const next = { ...stored, refreshToken: tokens.refreshToken };
    this.stored = next;
    await this.vault.save(next);
    if (this.stored !== next) return null;
    this.keepAccess(tokens);
    return tokens.accessToken;
  }

  private keepAccess(tokens: TokenResponse) {
    this.access = { token: tokens.accessToken, expiresAt: this.now() + tokens.expiresIn * 1000 };
  }

  private async end(reason: SignedOutReason) {
    this.generation += 1;
    this.access = null;
    this.stored = null;
    try {
      await this.vault.clear();
    } finally {
      // Signed out on screen (and the device's saved data cleared) even if the keychain
      // delete failed; the token left there no longer matches a session this app will use.
      this.setState({ status: 'signed_out', reason });
    }
  }

  private setState(state: SessionState) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}

/**
 * Wraps fetch so any 401 from an authenticated call ends the local session. Sign-in calls
 * are left alone: a wrong code there is a 401 too, and the screen shows it.
 */
export function expiringFetch(
  fetchImpl: typeof fetch,
  onUnauthenticated: (token: string | undefined) => void,
): typeof fetch {
  return async (input, init) => {
    const response = await fetchImpl(input, init);
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (response.status === 401 && !/\/auth\//.test(url)) {
      const header = new Headers(init?.headers).get('authorization');
      onUnauthenticated(header?.replace(/^Bearer /, '') || undefined);
    }
    return response;
  };
}
