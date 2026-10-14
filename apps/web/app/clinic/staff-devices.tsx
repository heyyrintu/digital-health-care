'use client';

import { ApiError } from '@dhc/api-client';
import { SignOutAllResponse, StaffSessionList, type StaffSession } from '@dhc/contracts';
import { formatIstDateTime } from '@dhc/domain';
import { Button } from '@dhc/ui-web';
import { useCallback, useEffect, useState } from 'react';
import { useSession } from './session-provider';

const BROWSERS: [RegExp, string][] = [
  [/Edg\//, 'Edge'],
  [/OPR\//, 'Opera'],
  [/Chrome\//, 'Chrome'],
  [/Firefox\//, 'Firefox'],
  [/Safari\//, 'Safari'],
  [/okhttp|Expo|Dalvik|CFNetwork/i, 'App'],
];
const SYSTEMS: [RegExp, string][] = [
  [/Android/, 'Android'],
  [/iPhone|iPad|iOS/, 'iOS'],
  [/Windows/, 'Windows'],
  [/Mac OS X|Macintosh/, 'macOS'],
  [/Linux/, 'Linux'],
];

/** "Chrome on Windows" from a user agent; the raw string stays in the tooltip. */
export function describeDevice(userAgent: string | null): string | null {
  if (!userAgent) return null;
  const browser = BROWSERS.find(([re]) => re.test(userAgent))?.[1];
  const system = SYSTEMS.find(([re]) => re.test(userAgent))?.[1];
  if (browser && system) return `${browser} · ${system}`;
  return browser ?? system ?? null;
}

/**
 * Clinic admin: one staff member's signed-in devices at this clinic, with sign-out for
 * each and for all of them. The admin's own current device can't be signed out here.
 */
export function StaffDevices({ userId, name }: { userId: string; name: string }) {
  const { api, signOut, t, locale } = useSession();
  const [sessions, setSessions] = useState<StaffSession[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handle = useCallback(
    (e: unknown) => {
      if (e instanceof ApiError && e.status === 401) return void signOut('expired');
      setError(e instanceof ApiError ? e.message : t('error.network'));
    },
    [signOut, t],
  );

  const load = useCallback(async () => {
    try {
      const list = await api.request('GET', `/staff/members/${userId}/sessions`, {
        schema: StaffSessionList,
      });
      setSessions(list.data);
    } catch (e) {
      handle(e);
    }
  }, [api, userId, handle]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      await load();
    } catch (e) {
      handle(e);
    } finally {
      setBusy(false);
    }
  }

  const revoke = (s: StaffSession) =>
    run(async () => {
      await api.revokeStaffSession(s.id);
      setNotice(t('devices.signedOutOne'));
    });

  const revokeAll = () =>
    run(async () => {
      const { revoked } = await api.request('POST', `/staff/members/${userId}/sign-out-all`, {
        schema: SignOutAllResponse,
      });
      setNotice(t('devices.signedOutAll', { count: revoked, name }));
    });

  const others = sessions?.filter((s) => !s.current) ?? [];

  return (
    <div
      className="mt-3 space-y-3 rounded-xl bg-muted/60 p-4 text-sm"
      role="group"
      aria-label={t('devices.title', { name })}
      data-testid={`devices-${userId}`}
    >
      <p className="font-semibold">{t('devices.title', { name })}</p>
      {sessions && sessions.length === 0 && (
        <p className="text-muted-foreground">{t('devices.none')}</p>
      )}
      {sessions && sessions.length > 0 && (
        <ul className="divide-y divide-border/70">
          {sessions.map((s) => (
            <li
              key={s.id}
              className="flex flex-wrap items-center justify-between gap-3 py-2"
              data-testid="device"
            >
              <div className="min-w-0">
                <p className="font-medium" title={s.userAgent ?? undefined}>
                  {describeDevice(s.userAgent) ?? t('devices.unknown')}
                  {s.current && (
                    <span className="ml-2 rounded-full bg-accent px-2 py-0.5 text-xs font-semibold text-accent-foreground">
                      {t('devices.thisDevice')}
                    </span>
                  )}
                </p>
                <p className="text-muted-foreground">
                  {t('devices.lastUsed', { date: formatIstDateTime(s.lastUsedAt, locale) })}
                  {s.ip ? ` · ${s.ip}` : ''}
                </p>
              </div>
              {!s.current && (
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void revoke(s)}
                >
                  {t('devices.signOut')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {others.length > 1 && (
        <Button
          type="button"
          variant="destructive"
          disabled={busy}
          onClick={() => void revokeAll()}
        >
          {t('devices.signOutAll')}
        </Button>
      )}
      {notice && (
        <p role="status" className="text-muted-foreground">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="font-medium text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
