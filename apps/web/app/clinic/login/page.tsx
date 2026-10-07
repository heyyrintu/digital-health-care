'use client';

import { ApiError } from '@dhc/api-client';
import type { LoginResponse } from '@dhc/contracts';
import { Button, Input } from '@dhc/ui-web';
import { Stethoscope } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState, type FormEvent } from 'react';
import { isSixDigitCode } from '../../../lib/invite';
import { postSession, rolesFromField, type SessionTokens } from '../../../lib/session-client';
import { LocaleToggle, useSession } from '../session-provider';

const LAST_CLINIC_KEY = 'dhc.lastClinic';
const LABEL = 'block text-sm font-medium';

export default function LoginPage() {
  return (
    <Suspense>
      <Login />
    </Suspense>
  );
}

type Step = { kind: 'password'; roles: string[] } | { kind: 'code'; mfaToken: string };

/** Staff sign-in: clinic, email or mobile and password, then the authenticator code. */
function Login() {
  const { status, endedReason, startSession, t } = useSession();
  const router = useRouter();
  const params = useSearchParams();
  const [step, setStep] = useState<Step>({ kind: 'password', roles: [] });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [clinic, setClinic] = useState('');

  useEffect(() => {
    let remembered = '';
    try {
      remembered = window.localStorage.getItem(LAST_CLINIC_KEY) ?? '';
    } catch {
      // Storage unavailable (private mode): the field just starts empty.
    }
    setClinic(params.get('clinic') ?? remembered);
  }, [params]);

  useEffect(() => {
    if (status === 'signedIn') router.replace('/clinic');
  }, [status, router]);

  function messageFor(e: unknown): string {
    if (e instanceof ApiError) return e.message;
    if (e instanceof TypeError) return t('error.network');
    return t('error.generic');
  }

  async function submitPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const organisation = String(form.get('organisation') ?? '')
      .trim()
      .toLowerCase();
    const role = form.get('role');
    setBusy(true);
    setError(null);
    try {
      const result = await postSession<LoginResponse>('login', {
        organisation,
        identifier: String(form.get('identifier') ?? ''),
        password: String(form.get('password') ?? ''),
        ...(role ? { role: String(role) } : {}),
      });
      try {
        window.localStorage.setItem(LAST_CLINIC_KEY, organisation);
      } catch {
        // Remembering the clinic is only a convenience.
      }
      setStep({ kind: 'code', mfaToken: result.mfaToken });
    } catch (e) {
      const roles = e instanceof ApiError ? rolesFromField(e.fields.role) : [];
      if (roles.length > 1) setStep({ kind: 'password', roles });
      else setError(messageFor(e));
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(event: FormEvent<HTMLFormElement>, mfaToken: string) {
    event.preventDefault();
    const code = String(new FormData(event.currentTarget).get('code') ?? '').replace(/\s/g, '');
    if (!isSixDigitCode(code)) return setError(t('invite.codeInvalid'));
    setBusy(true);
    setError(null);
    try {
      await startSession(await postSession<SessionTokens>('mfa', { mfaToken, code }));
      router.replace('/clinic');
    } catch (e) {
      // An expired MFA step means starting again from the password.
      if (e instanceof ApiError && e.message.includes('Start again')) {
        setStep({ kind: 'password', roles: [] });
      }
      setError(messageFor(e));
    } finally {
      setBusy(false);
    }
  }

  const notice =
    endedReason === 'idle'
      ? t('session.idleSignedOut')
      : endedReason === 'expired'
        ? t('session.expired')
        : null;

  return (
    <main className="grid min-h-screen place-items-center bg-hero px-4 py-10 font-sans text-foreground">
      <div className="surface w-full max-w-md p-6 sm:p-8">
        <div className="mb-6 flex items-start justify-between gap-3">
          <span
            className="grid h-12 w-12 place-items-center rounded-2xl bg-primary font-display text-xl font-bold text-primary-foreground shadow-button"
            aria-hidden
          >
            <Stethoscope className="size-6" />
          </span>
          <LocaleToggle />
        </div>
        <h1 className="mb-6 font-display text-2xl font-extrabold">{t('login.title')}</h1>

        {notice && !error && (
          <p role="status" className="mb-4 rounded-xl bg-info-soft px-4 py-3 text-sm">
            {notice}
          </p>
        )}
        {error && (
          <p
            role="alert"
            className="mb-4 rounded-xl bg-danger-soft px-4 py-3 text-sm font-medium text-destructive"
          >
            {error}
          </p>
        )}

        {step.kind === 'password' && (
          <form className="space-y-4" onSubmit={(e) => void submitPassword(e)} noValidate>
            <div className="space-y-1.5">
              <label htmlFor="organisation" className={LABEL}>
                {t('login.clinic')}
              </label>
              <Input
                id="organisation"
                name="organisation"
                required
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                value={clinic}
                onChange={(e) => setClinic(e.target.value)}
                aria-describedby="organisation-hint"
              />
              <p id="organisation-hint" className="text-xs text-muted-foreground">
                {t('login.clinicHint')}
              </p>
            </div>
            <div className="space-y-1.5">
              <label htmlFor="identifier" className={LABEL}>
                {t('login.identifier')}
              </label>
              <Input id="identifier" name="identifier" required autoComplete="username" />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="password" className={LABEL}>
                {t('login.password')}
              </label>
              <Input
                id="password"
                name="password"
                type="password"
                required
                autoComplete="current-password"
              />
            </div>
            {step.roles.length > 1 && (
              <fieldset className="roles rounded-xl border border-border p-4">
                <legend className="px-1 text-sm font-medium">{t('login.chooseRole')}</legend>
                {step.roles.map((role, i) => (
                  <label key={role} className="radio flex min-h-11 items-center gap-3 text-sm">
                    <input
                      type="radio"
                      name="role"
                      value={role}
                      defaultChecked={i === 0}
                      className="size-4 accent-[var(--color-primary)]"
                    />
                    {t(`role.${role as 'doctor' | 'front_desk' | 'clinic_admin'}`)}
                  </label>
                ))}
              </fieldset>
            )}
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
              onClick={() => {
                setError(null);
                setStep({ kind: 'password', roles: [] });
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
