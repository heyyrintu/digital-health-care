'use client';

import { ApiError } from '@dhc/api-client';
import type { PlatformLoginResponse } from '@dhc/contracts';
import { Button, Input } from '@dhc/ui-web';
import { ShieldCheck } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { isSixDigitCode } from '../../../lib/invite';
import { mfaExpired, platformErrorKey, type PlatformStep } from '../../../lib/platform';
import { postPlatformSession, type SessionTokens } from '../../../lib/session-client';
import { PlatformLocaleToggle, usePlatformSession } from '../session-provider';

const LABEL = 'block text-sm font-medium';

type Step = { kind: 'password' } | { kind: 'code'; mfaToken: string };

/** Platform operators' sign-in: work email and password, then the authenticator code. */
export default function PlatformLoginPage() {
  const { status, endedReason, startSession, t } = usePlatformSession();
  const router = useRouter();
  const [step, setStep] = useState<Step>({ kind: 'password' });
  const [error, setError] = useState<string | null>(null);
  /** Whether the error is about what was typed (marks the fields invalid), not the network. */
  const [invalid, setInvalid] = useState(false);
  const [busy, setBusy] = useState(false);
  // Kept when the code step sends the operator back to the password.
  const [email, setEmail] = useState('');

  useEffect(() => {
    if (status === 'signedIn') router.replace('/platform');
  }, [status, router]);

  function fail(e: unknown, at: PlatformStep) {
    setInvalid(e instanceof ApiError && (e.status === 401 || e.status === 400));
    setError(messageFor(e, at));
  }

  function messageFor(e: unknown, at: PlatformStep): string {
    const key = platformErrorKey(e, at);
    if (key) return t(key);
    return e instanceof Error ? e.message : t('error.generic');
  }

  async function submitPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    setInvalid(false);
    try {
      const result = await postPlatformSession<PlatformLoginResponse>('login', {
        email: email.trim(),
        password: String(form.get('password') ?? ''),
      });
      setStep({ kind: 'code', mfaToken: result.mfaToken });
    } catch (e) {
      fail(e, 'password');
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(event: FormEvent<HTMLFormElement>, mfaToken: string) {
    event.preventDefault();
    const code = String(new FormData(event.currentTarget).get('code') ?? '').replace(/\s/g, '');
    if (!isSixDigitCode(code)) {
      setInvalid(true);
      return setError(t('invite.codeInvalid'));
    }
    setBusy(true);
    setError(null);
    setInvalid(false);
    try {
      await startSession(await postPlatformSession<SessionTokens>('mfa', { mfaToken, code }));
      router.replace('/platform');
    } catch (e) {
      // An expired code step means starting again from the password.
      if (mfaExpired(e)) setStep({ kind: 'password' });
      fail(e, 'code');
    } finally {
      setBusy(false);
    }
  }

  const notice =
    endedReason === 'idle'
      ? t('session.idleSignedOut')
      : endedReason === 'expired'
        ? t('session.expired')
        : endedReason === 'network'
          ? t('platform.error.network')
          : endedReason === 'offline'
            ? t('error.network')
            : null;

  return (
    <main className="grid min-h-screen place-items-center bg-hero px-4 py-10 font-sans text-foreground">
      <div className="surface w-full max-w-md p-6 sm:p-8">
        <div className="mb-6 flex items-start justify-between gap-3">
          <span
            className="grid h-12 w-12 place-items-center rounded-2xl bg-primary font-display text-xl font-bold text-primary-foreground shadow-button"
            aria-hidden
          >
            <ShieldCheck className="size-6" />
          </span>
          <PlatformLocaleToggle />
        </div>
        <h1 className="font-display text-2xl font-extrabold">{t('platform.login.title')}</h1>
        <p className="mb-6 mt-1.5 text-sm text-muted-foreground">{t('platform.login.hint')}</p>

        {notice && !error && (
          <p role="status" className="mb-4 rounded-xl bg-info-soft px-4 py-3 text-sm">
            {notice}
          </p>
        )}
        {error && (
          <p
            id="login-error"
            role="alert"
            className="mb-4 rounded-xl bg-danger-soft px-4 py-3 text-sm font-medium text-destructive"
          >
            {error}
          </p>
        )}

        {step.kind === 'password' && (
          <form className="space-y-4" onSubmit={(e) => void submitPassword(e)}>
            <div className="space-y-1.5">
              <label htmlFor="email" className={LABEL}>
                {t('platform.login.email')}
              </label>
              <Input
                id="email"
                aria-invalid={invalid ? true : undefined}
                aria-describedby={error ? 'login-error' : undefined}
                name="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="password" className={LABEL}>
                {t('login.password')}
              </label>
              <Input
                id="password"
                aria-invalid={invalid ? true : undefined}
                aria-describedby={error ? 'login-error' : undefined}
                name="password"
                type="password"
                required
                autoComplete="current-password"
              />
            </div>
            <Button type="submit" size="lg" className="w-full" disabled={busy}>
              {t('login.signIn')}
            </Button>
          </form>
        )}

        {step.kind === 'code' && (
          <form
            className="space-y-4"
            onSubmit={(e) => void submitCode(e, step.mfaToken)}
            noValidate
          >
            <div className="space-y-1.5">
              <label htmlFor="code" className={LABEL}>
                {t('login.codeTitle')}
              </label>
              <Input
                id="code"
                aria-invalid={invalid ? true : undefined}
                aria-describedby={error ? 'login-error' : undefined}
                name="code"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={7}
                autoComplete="one-time-code"
                className="tabular text-center text-lg tracking-[0.3em]"
                required
                autoFocus
              />
            </div>
            <Button type="submit" size="lg" className="w-full" disabled={busy}>
              {t('login.verify')}
            </Button>
            <Button
              type="button"
              variant="link"
              className="w-full"
              disabled={busy}
              onClick={() => {
                setError(null);
                setInvalid(false);
                setStep({ kind: 'password' });
              }}
            >
              {t('login.startOver')}
            </Button>
          </form>
        )}
      </div>
    </main>
  );
}
