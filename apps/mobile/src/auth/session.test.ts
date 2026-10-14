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

describe('expiringFetch', () => {
  it('reports a 401 from a signed-in call but not from a sign-in call', async () => {
    const onUnauthenticated = vi.fn();
    const fetchImpl = vi.fn(async () => new Response(null, { status: 401 }));
    const wrapped = expiringFetch(fetchImpl, onUnauthenticated);

    await wrapped('https://api.test/v1/auth/otp/verify', { method: 'POST' });
    expect(onUnauthenticated).not.toHaveBeenCalled();
    await wrapped('https://api.test/v1/me');
    expect(onUnauthenticated).toHaveBeenCalledTimes(1);
  });
});
