import type { MeResponse, TokenResponse } from '@dhc/contracts';
import { describe, expect, it, vi } from 'vitest';
import {
  expiringFetch,
  REFRESH_LEAD_MS,
  SessionManager,
  type SessionApi,
  type StoredSession,
  type TokenVault,
} from './session';

const me: MeResponse = {
  user: {
    id: '6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f',
    displayName: 'Asha',
    phone: null,
    email: null,
  },
  organisation: { id: '7a1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f', slug: 'demo-clinic', name: 'Demo' },
  role: 'patient',
};

function tokens(n: number): TokenResponse {
  return { tokenType: 'Bearer', accessToken: `a${n}`, expiresIn: 900, refreshToken: `r${n}` };
}

function setup(saved: StoredSession | null = null) {
  let stored = saved;
  const vault: TokenVault = {
    load: vi.fn(async () => stored),
    save: vi.fn(async (s: StoredSession) => {
      stored = s;
    }),
    clear: vi.fn(async () => {
      stored = null;
    }),
  };
  let n = 0;
  const api = {
    refresh: vi.fn(async (_refreshToken: string) => tokens(++n)),
    me: vi.fn(async (_token: string) => me),
    logout: vi.fn(async (_token: string) => undefined),
  } satisfies SessionApi;
  let time = 1_000_000;
  const clock = { advance: (ms: number) => (time += ms) };
  const manager = new SessionManager(vault, api, () => time);
  return { manager, vault, api, clock, stored: () => stored };
}

const authError = Object.assign(new Error('Please sign in again.'), { status: 401 });

describe('SessionManager', () => {
  it('is signed out when nothing is saved', async () => {
    const { manager, api } = setup();
    await manager.restore();
    expect(manager.getState()).toEqual({ status: 'signed_out' });
    expect(api.refresh).not.toHaveBeenCalled();
  });

  it('resumes a saved session and rotates the refresh token', async () => {
    const { manager, api, stored } = setup({ organisation: 'demo-clinic', refreshToken: 'r0' });
    await manager.restore();
    expect(api.refresh).toHaveBeenCalledWith('r0');
    expect(manager.getState()).toEqual({ status: 'signed_in', me });
    expect(stored()).toEqual({ organisation: 'demo-clinic', refreshToken: 'r1' });
    await expect(manager.getAccessToken()).resolves.toBe('a1');
  });

  it('forgets a saved session the API rejects', async () => {
    const { manager, api, stored } = setup({ organisation: 'demo-clinic', refreshToken: 'old' });
    api.refresh.mockRejectedValueOnce(authError);
    await manager.restore();
    expect(manager.getState()).toEqual({ status: 'signed_out', reason: 'expired' });
    expect(stored()).toBeNull();
  });

  it('keeps a saved session when the network is down, so a retry can resume it', async () => {
    const { manager, api, stored } = setup({ organisation: 'demo-clinic', refreshToken: 'r0' });
    api.refresh.mockRejectedValueOnce(new TypeError('Network request failed'));
    await manager.restore();
    expect(manager.getState()).toEqual({ status: 'unreachable' });
    expect(stored()).toEqual({ organisation: 'demo-clinic', refreshToken: 'r0' });
    await manager.restore();
    expect(manager.getState()).toMatchObject({ status: 'signed_in' });
  });

  it('refreshes shortly before expiry, once, however many requests ask at the same time', async () => {
    const { manager, api, clock } = setup();
    await manager.signIn('demo-clinic', tokens(0));
    await expect(manager.getAccessToken()).resolves.toBe('a0');

    clock.advance(900_000 - REFRESH_LEAD_MS);
    const results = await Promise.all([1, 2, 3].map(() => manager.getAccessToken()));
    expect(results).toEqual(['a1', 'a1', 'a1']);
    expect(api.refresh).toHaveBeenCalledTimes(1);
    expect(api.refresh).toHaveBeenCalledWith('r0');
  });

  it('signs out locally even when the logout call fails', async () => {
    const { manager, api, stored } = setup();
    await manager.signIn('demo-clinic', tokens(0));
    api.logout.mockRejectedValueOnce(new TypeError('offline'));
    await manager.signOut();
    expect(api.logout).toHaveBeenCalledWith('a0');
    expect(manager.getState()).toEqual({ status: 'signed_out', reason: 'signed_out' });
    expect(stored()).toBeNull();
    await expect(manager.getAccessToken()).resolves.toBeNull();
    expect(manager.organisation).toBeUndefined();
  });

  it('does not bring a session back when sign-out lands during a refresh', async () => {
    const { manager, api, clock, stored } = setup();
    await manager.signIn('demo-clinic', tokens(0));
    clock.advance(900_000);
    let release!: (t: TokenResponse) => void;
    api.refresh.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    const pending = manager.getAccessToken();
    await manager.signOut();
    release(tokens(9));
    await expect(pending).resolves.toBeNull();
    expect(stored()).toBeNull();
  });

  it('ends the session when the API says it was revoked', async () => {
    const { manager } = setup();
    await manager.signIn('demo-clinic', tokens(0));
    const listener = vi.fn();
    manager.subscribe(listener);
    await manager.expire();
    expect(manager.getState()).toEqual({ status: 'signed_out', reason: 'expired' });
    expect(listener).toHaveBeenCalled();
  });
});

describe('SessionManager across sign-outs', () => {
  it('keeps nothing when sign-out comes while a sign-in is loading who signed in', async () => {
    const { manager, api, stored } = setup();
    let answer: (value: MeResponse) => void = () => undefined;
    api.me.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    const signingIn = manager.signIn('demo-clinic', tokens(0));
    await manager.signOut();
    answer(me);
    await signingIn;
    expect(manager.getState()).toEqual({ status: 'signed_out', reason: 'signed_out' });
    expect(stored()).toBeNull();
    await expect(manager.getAccessToken()).resolves.toBeNull();
  });

  it('does not clear a newer sign-in’s saved session when an older one finishes late', async () => {
    const { manager, api, stored } = setup();
    let answerA: (value: MeResponse) => void = () => undefined;
    api.me.mockImplementationOnce(() => new Promise((resolve) => (answerA = resolve)));
    const a = manager.signIn('demo-clinic', tokens(1));
    const b = manager.signIn('demo-clinic', tokens(2));
    await b;
    answerA(me);
    await a;
    expect(stored()).toEqual({ organisation: 'demo-clinic', refreshToken: 'r2' });
    expect(manager.getState().status).toBe('signed_in');
  });

  it('keeps nothing when an overtaken sign-in saved and the newer one then fails', async () => {
    const { manager, api, vault, stored } = setup();
    // A's keychain write is slow and lands after B has started.
    const write = vi.mocked(vault.save).getMockImplementation()!;
    let saved: () => void = () => undefined;
    vi.mocked(vault.save).mockImplementationOnce(
      (s) => new Promise<void>((resolve) => (saved = () => void write(s).then(resolve))),
    );
    let failB: (error: Error) => void = () => undefined;
    const a = manager.signIn('demo-clinic', tokens(1));
    await vi.waitFor(() => expect(vault.save).toHaveBeenCalled());
    api.me.mockImplementationOnce(() => new Promise((_, reject) => (failB = reject)));
    const b = manager.signIn('demo-clinic', tokens(2));
    saved();
    await a;
    expect(stored()).toEqual({ organisation: 'demo-clinic', refreshToken: 'r1' });
    failB(new TypeError('Network request failed'));
    await expect(b).rejects.toThrow();
    expect(vault.clear).toHaveBeenCalled();
    expect(stored()).toBeNull();
    expect(manager.getState().status).not.toBe('signed_in');
  });

  it('keeps nothing when who signed in cannot be loaded', async () => {
    const { manager, api, stored } = setup();
    api.me.mockRejectedValueOnce(new TypeError('Network request failed'));
    await expect(manager.signIn('demo-clinic', tokens(0))).rejects.toThrow();
    expect(stored()).toBeNull();
    await expect(manager.getAccessToken()).resolves.toBeNull();
  });

  it('ignores a 401 that answers a previous session’s request', async () => {
    const { manager } = setup();
    await manager.signIn('demo-clinic', tokens(7));
    await manager.expire('a-previous-token');
    expect(manager.getState().status).toBe('signed_in');
    await manager.expire('a7');
    expect(manager.getState()).toEqual({ status: 'signed_out', reason: 'expired' });
  });

  it('refreshes once to end the server session when the access token has run out', async () => {
    const { manager, api, clock } = setup();
    await manager.signIn('demo-clinic', tokens(0));
    clock.advance(901_000);
    await manager.signOut();
    expect(api.refresh).toHaveBeenCalledTimes(1);
    expect(api.refresh).toHaveBeenCalledWith('r0');
    expect(api.logout).toHaveBeenCalledWith('a1');
  });

  it('signs out on screen even when the keychain cannot be cleared', async () => {
    const { manager, vault, api } = setup();
    await manager.signIn('demo-clinic', tokens(0));
    vi.mocked(vault.clear).mockRejectedValueOnce(new Error('keychain'));
    await expect(manager.signOut()).rejects.toThrow('keychain');
    expect(manager.getState()).toEqual({ status: 'signed_out', reason: 'signed_out' });
    // The server session still ends, so the token left in the keychain cannot resume it.
    expect(api.logout).toHaveBeenCalledWith('a0');
  });

  it('starts from sign-in when the keychain cannot be read', async () => {
    const { manager, vault } = setup();
    vi.mocked(vault.load).mockRejectedValueOnce(new Error('keychain'));
    await manager.restore();
    expect(manager.getState()).toEqual({ status: 'signed_out' });
  });
});

describe('expiringFetch', () => {
  it('reports a 401 from a signed-in call but not from a sign-in call', async () => {
    const onUnauthenticated = vi.fn();
    const fetchImpl = vi.fn(async () => new Response(null, { status: 401 }));
    const wrapped = expiringFetch(fetchImpl, onUnauthenticated);

    await wrapped('https://api.test/v1/auth/otp/verify', { method: 'POST' });
    expect(onUnauthenticated).not.toHaveBeenCalled();
    await wrapped('https://api.test/v1/me', { headers: { authorization: 'Bearer a1' } });
    expect(onUnauthenticated).toHaveBeenCalledTimes(1);
    expect(onUnauthenticated).toHaveBeenCalledWith('a1');
  });
});
