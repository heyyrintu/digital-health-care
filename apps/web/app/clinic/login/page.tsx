'use client';

import { ApiError } from '@dhc/api-client';
import type { LoginResponse } from '@dhc/contracts';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState, type FormEvent } from 'react';
import { isSixDigitCode } from '../../../lib/invite';
import { postSession, rolesFromField, type SessionTokens } from '../../../lib/session-client';
import { LocaleToggle, useSession } from '../session-provider';

const LAST_CLINIC_KEY = 'dhc.lastClinic';

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
    <main className="shell narrow">
      <div className="card">
        <div className="card-header">
          <h1>{t('login.title')}</h1>
          <LocaleToggle />
        </div>

        {notice && !error && (
          <p role="status" className="notice">
            {notice}
          </p>
        )}
        {error && (
          <p role="alert" className="alert">
            {error}
          </p>
        )}

        {step.kind === 'password' && (
          <form onSubmit={(e) => void submitPassword(e)} noValidate>
            <label htmlFor="organisation">{t('login.clinic')}</label>
            <input
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
            <p id="organisation-hint" className="hint">
              {t('login.clinicHint')}
            </p>
            <label htmlFor="identifier">{t('login.identifier')}</label>
            <input id="identifier" name="identifier" required autoComplete="username" />
            <label htmlFor="password">{t('login.password')}</label>
            <input
              id="password"
              name="password"
              type="password"
              required
              autoComplete="current-password"
            />
            {step.roles.length > 1 && (
              <fieldset className="roles">
                <legend>{t('login.chooseRole')}</legend>
                {step.roles.map((role, i) => (
                  <label key={role} className="radio">
                    <input type="radio" name="role" value={role} defaultChecked={i === 0} />
                    {t(`role.${role as 'doctor' | 'front_desk' | 'clinic_admin'}`)}
                  </label>
                ))}
              </fieldset>
            )}
            <button type="submit" disabled={busy}>
              {t('login.signIn')}
            </button>
          </form>
        )}

        {step.kind === 'code' && (
          <form onSubmit={(e) => void submitCode(e, step.mfaToken)} noValidate>
            <label htmlFor="code">{t('login.codeTitle')}</label>
            <input
              id="code"
              name="code"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={7}
              autoComplete="one-time-code"
              required
              autoFocus
            />
            <button type="submit" disabled={busy}>
              {t('login.verify')}
            </button>
            <button
              type="button"
              className="link-button"
              onClick={() => {
                setError(null);
                setStep({ kind: 'password', roles: [] });
              }}
            >
              {t('login.startOver')}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
