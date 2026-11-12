'use client';
import { useEffect, useState, type FormEvent } from 'react';
import { Button, Input } from '@dhc/ui-web';
import { SecurityChallengeResponse } from '@dhc/contracts';
import { useSession } from '../../app/clinic/session-provider';
import { usePlatformSession } from '../../app/platform/session-provider';

export function StaffForgotPassword() {
  const { t } = useSession();
  return <Recovery platform={false} t={t} />;
}
export function PlatformForgotPassword() {
  const { t } = usePlatformSession();
  return <Recovery platform t={t} />;
}
type Translator = ReturnType<typeof useSession>['t'];
function Recovery({ platform, t }: { platform: boolean; t: Translator }) {
  const [challenge, setChallenge] = useState<string | null>(null),
    [organisation, setOrganisation] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const login = platform ? '/platform/login' : '/clinic/login';
  useEffect(() => {
    if (!platform) {
      try {
        setOrganisation(
          new URLSearchParams(window.location.search).get('clinic') ??
            window.localStorage.getItem('dhc.lastClinic') ??
            '',
        );
      } catch {
        /* Optional remembered clinic. */
      }
    }
  }, [platform]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    try {
      const newPassword = String(data.get('newPassword') ?? '');
      if (challenge && newPassword !== data.get('confirmPassword'))
        throw new Error(t('security.passwordMismatch'));
      const response = await fetch(
        `/api/${platform ? 'platform-session' : 'session'}/password/${challenge ? 'confirm' : 'request'}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
          cache: 'no-store',
          body: JSON.stringify({
            ...(!platform ? { organisation } : {}),
            ...(challenge
              ? { challengeId: challenge, code: data.get('code'), newPassword }
              : { identifier: data.get('identifier') }),
          }),
        },
      );
      const payload = response.status === 204 ? null : await response.json();
      if (!response.ok) throw new Error(payload?.error?.message ?? t('error.generic'));
      if (challenge) {
        window.location.assign(`${login}?password=reset`);
        return;
      }
      setChallenge(SecurityChallengeResponse.parse(payload).challengeId);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('error.network'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="grid min-h-screen place-items-center bg-background p-6">
      <section className="surface w-full max-w-md space-y-5 p-6">
        <h1 className="font-display text-2xl font-bold">{t('security.forgot')}</h1>
        <p>{t(challenge ? 'security.recoverySent' : 'security.recoveryHint')}</p>
        {error && <p role="alert">{error}</p>}
        <form onSubmit={(e) => void submit(e)} className="space-y-4">
          {!challenge && (
            <>
              {!platform && (
                <label className="block">
                  {t('login.clinic')}
                  <Input
                    required
                    value={organisation}
                    onChange={(e) => setOrganisation(e.target.value.trim().toLowerCase())}
                    autoComplete="organization"
                  />
                </label>
              )}
              <label className="block">
                {t(platform ? 'people.email' : 'login.identifier')}
                <Input
                  required
                  name="identifier"
                  type={platform ? 'email' : 'text'}
                  autoComplete="username"
                  maxLength={254}
                />
              </label>
            </>
          )}
          {challenge && (
            <>
              <label className="block">
                {t('security.emailCode')}
                <Input
                  required
                  name="code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6}"
                  maxLength={6}
                />
              </label>
              <label className="block">
                {t('security.newPassword')}
                <Input
                  required
                  name="newPassword"
                  type="password"
                  autoComplete="new-password"
                  minLength={12}
                  maxLength={256}
                />
              </label>
              <label className="block">
                {t('security.confirmPassword')}
                <Input
                  required
                  name="confirmPassword"
                  type="password"
                  autoComplete="new-password"
                  minLength={12}
                  maxLength={256}
                />
              </label>
            </>
          )}
          <Button type="submit" disabled={busy}>
            {t(challenge ? 'security.resetPassword' : 'security.sendRecovery')}
          </Button>
        </form>
        {challenge && (
          <button
            type="button"
            onClick={() => {
              setChallenge(null);
              setError('');
            }}
          >
            {t('security.startAgain')}
          </button>
        )}
        <a className="block underline" href={login}>
          {t('security.backToLogin')}
        </a>
      </section>
    </main>
  );
}
