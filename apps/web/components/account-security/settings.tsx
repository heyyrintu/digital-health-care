'use client';
import { useEffect, useState, useEffectEvent, type FormEvent } from 'react';
import type { ApiClient } from '@dhc/api-client';
import {
  SecuritySettingsResponse,
  SecurityChangeResponse,
  SecurityChangedResponse,
} from '@dhc/contracts';
import type {
  AccountSecuritySettings,
  AccountSecurityChange,
  SecondFactorMethodValue,
} from '@dhc/contracts';
import { Button, Input, Surface } from '@dhc/ui-web';
import type { useSession } from '../../app/clinic/session-provider';

type Settings = AccountSecuritySettings;
type Challenge = AccountSecurityChange;
type Translator = ReturnType<typeof useSession>['t'];

export function SecuritySettings({
  api,
  platform = false,
  t,
  onChanged,
}: {
  api: ApiClient;
  platform?: boolean;
  t: Translator;
  onChanged: () => Promise<void>;
}) {
  const [settings, setSettings] = useState<Settings | null>(null),
    [method, setMethod] = useState(''),
    [challenge, setChallenge] = useState<Challenge | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const base = `${platform ? '/platform' : ''}/auth/security`;
  const reportError = useEffectEvent((e: unknown) =>
    setError(e instanceof Error ? e.message : t('error.generic')),
  );
  useEffect(() => {
    let live = true;
    api
      .request('GET', base, { schema: SecuritySettingsResponse })
      .then((r) => {
        if (live) {
          setSettings(r);
          setMethod(r.method);
        }
      })
      .catch((e) => {
        if (live) reportError(e);
      });
    return () => {
      live = false;
    };
  }, [api, base]);
  const label = (value: SecondFactorMethodValue) => t(`security.method.${value}`);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    setError('');
    try {
      if (challenge) {
        await api.request('POST', `${base}/confirm`, {
          schema: SecurityChangedResponse,
          body: {
            challengeId: challenge.challengeId,
            ...(challenge.currentMethod !== 'disabled'
              ? { currentCode: data.get('currentCode') }
              : {}),
            ...(challenge.targetMethod !== 'disabled' ? { newCode: data.get('newCode') } : {}),
          },
        });
        await onChanged();
      } else {
        const result = await api.request('POST', `${base}/request`, {
          schema: SecurityChangeResponse,
          body: { password: data.get('password'), method },
        });
        form.reset();
        setChallenge(result);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t('error.generic'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Surface className="space-y-4 p-5">
      <h2 className="font-display text-xl font-bold">{t('security.title')}</h2>
      {error && <p role="alert">{error}</p>}
      {settings && (
        <>
          <p>
            {t('security.current')}: <strong>{label(settings.method)}</strong>
          </p>
          <p>{t('security.settingsHint')}</p>
          <form onSubmit={(e) => void submit(e)} className="space-y-4">
            {!challenge ? (
              <>
                <label className="block">
                  {t('security.chooseMethod')}
                  <select
                    className="block w-full rounded-xl border p-3"
                    value={method}
                    onChange={(e) => setMethod(e.target.value)}
                  >
                    {settings.available.map((m) => (
                      <option value={m} key={m}>
                        {label(m)}
                      </option>
                    ))}
                  </select>
                </label>
                {method === 'disabled' && <p>{t('security.offHint')}</p>}
                <label className="block">
                  {t('login.password')}
                  <Input
                    name="password"
                    type="password"
                    autoComplete="current-password"
                    required
                    maxLength={256}
                  />
                </label>
                <Button type="submit" disabled={busy || method === settings.method}>
                  {t('security.continue')}
                </Button>
              </>
            ) : (
              <>
                <p>{t('security.confirmHint')}</p>
                <p>
                  {t('security.chooseMethod')}: <strong>{label(challenge.targetMethod)}</strong>
                </p>
                {challenge.currentMethod !== 'disabled' && (
                  <label className="block">
                    {t('security.currentCode')} ({label(challenge.currentMethod)})
                    <Input
                      name="currentCode"
                      required
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      pattern="[0-9]{6}"
                      maxLength={6}
                    />
                  </label>
                )}
                {challenge.targetMethod !== 'disabled' && (
                  <label className="block">
                    {t('security.newCode')} ({label(challenge.targetMethod)})
                    <Input
                      name="newCode"
                      required
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      pattern="[0-9]{6}"
                      maxLength={6}
                    />
                  </label>
                )}
                <Button type="submit" disabled={busy}>
                  {t('security.save')}
                </Button>
                <button
                  type="button"
                  disabled={busy}
                  className="ml-4 underline"
                  onClick={() => {
                    setChallenge(null);
                    setError('');
                  }}
                >
                  {t('security.startAgain')}
                </button>
              </>
            )}
          </form>
        </>
      )}
    </Surface>
  );
}
