'use client';

import { ApiError, createApiClient } from '@dhc/api-client';
import type { InviteDetails } from '@dhc/contracts';
import { formatIstDateTime } from '@dhc/domain';
import { t as translate, type Locale, type MessageKey } from '@dhc/i18n';
import Link from 'next/link';
import QRCode from 'qrcode';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  MIN_PASSWORD_LENGTH,
  groupKey,
  isSixDigitCode,
  newPasswordError,
  readInviteToken,
  secretFromOtpauth,
} from '../../lib/invite';

type Step =
  | { kind: 'loading' }
  | { kind: 'missing' }
  | { kind: 'invalid' }
  | { kind: 'password'; details: InviteDetails }
  | { kind: 'scan'; details: InviteDetails; secret: string; qr: string | null }
  | { kind: 'confirm'; details: InviteDetails }
  | { kind: 'done' };

/**
 * Staff invite: check the link, set (or confirm) the password, add the authenticator,
 * confirm its first code. The API decides everything; this only guides the person.
 */
export function InviteFlow({ apiBaseUrl }: { apiBaseUrl: string }) {
  const api = useMemo(() => createApiClient({ baseUrl: apiBaseUrl }), [apiBaseUrl]);
  const token = useRef<string | null>(null);
  const [locale, setLocale] = useState<Locale>('en');
  const [step, setStep] = useState<Step>({ kind: 'loading' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const t = (key: MessageKey, params?: Record<string, string | number>) =>
    translate(locale, key, params);

  useEffect(() => {
    token.current = readInviteToken(window.location.hash);
    // Drop the token from the address bar and this history entry.
    window.history.replaceState(null, '', window.location.pathname);
    if (!token.current) {
      setStep({ kind: 'missing' });
      return;
    }
    api
      .inspectInvite(token.current)
      .then((details) => setStep({ kind: 'password', details }))
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 404) setStep({ kind: 'invalid' });
        else setError(messageFor(e));
      });
    // Runs once per page load; the token is read from the URL only here.
  }, []);

  function messageFor(e: unknown, fallback: MessageKey = 'error.generic'): string {
    if (e instanceof ApiError) {
      if (e.status === 404) return t('invite.invalid');
      if (e.fields.password) return t('invite.passwordTooShort');
      return e.message;
    }
    if (e instanceof TypeError) return t('error.network');
    return t(fallback);
  }

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  }

  async function submitPassword(event: FormEvent<HTMLFormElement>, details: InviteDetails) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const password = String(form.get('password') ?? '');
    if (details.account === 'new') {
      const problem = newPasswordError(password, String(form.get('confirm') ?? ''));
      if (problem) return setError(t(problem));
    }
    await run(async () => {
      try {
        const result = await api.acceptInvite(token.current!, password);
        if (result.status === 'confirm_required') return setStep({ kind: 'confirm', details });
        const secret = secretFromOtpauth(result.otpauthUri) ?? '';
        const qr = await QRCode.toDataURL(result.otpauthUri, { margin: 1, width: 220 }).catch(
          () => null,
        );
        setStep({ kind: 'scan', details, secret, qr });
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return setStep({ kind: 'invalid' });
        setError(messageFor(e));
      }
    });
  }

  async function submitCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = String(new FormData(event.currentTarget).get('code') ?? '').replace(/\s/g, '');
    if (!isSixDigitCode(code)) return setError(t('invite.codeInvalid'));
    await run(async () => {
      try {
        const tokens = await api.completeInvite(token.current!, code);
        token.current = null;
        // The web dashboard has no signed-in session yet, so end this one straight away.
        await createApiClient({ baseUrl: apiBaseUrl, getAccessToken: () => tokens.accessToken })
          .logout()
          .catch(() => undefined);
        setStep({ kind: 'done' });
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return setStep({ kind: 'invalid' });
        if (e instanceof ApiError && e.status === 401) return setError(t('invite.codeInvalid'));
        setError(messageFor(e));
      }
    });
  }

  return (
    <div className="card">
      <div className="card-header">
        <h1>{t('invite.title')}</h1>
        <button
          type="button"
          className="link-button"
          onClick={() => setLocale(locale === 'en' ? 'hi' : 'en')}
          lang={locale === 'en' ? 'hi' : 'en'}
        >
          {locale === 'en' ? 'हिंदी' : 'English'}
        </button>
      </div>

      {error && (
        <p role="alert" className="alert">
          {error}
        </p>
      )}

      {step.kind === 'loading' && !error && <p aria-live="polite">{t('invite.loading')}</p>}
      {step.kind === 'missing' && <p role="alert">{t('invite.missingToken')}</p>}
      {step.kind === 'invalid' && <p role="alert">{t('invite.invalid')}</p>}

      {(step.kind === 'password' || step.kind === 'scan' || step.kind === 'confirm') && (
        <Summary details={step.details} t={t} locale={locale} />
      )}

      {step.kind === 'password' && (
        <form onSubmit={(e) => void submitPassword(e, step.details)} noValidate>
          {step.details.account === 'existing' && <p>{t('invite.existingIntro')}</p>}
          <label htmlFor="password">
            {step.details.account === 'new'
              ? t('invite.passwordNew')
              : t('invite.passwordExisting')}
          </label>
          <input
            id="password"
            name="password"
            type="password"
            required
            minLength={step.details.account === 'new' ? MIN_PASSWORD_LENGTH : 1}
            autoComplete={step.details.account === 'new' ? 'new-password' : 'current-password'}
            aria-describedby={step.details.account === 'new' ? 'password-hint' : undefined}
          />
          {step.details.account === 'new' && (
            <>
              <p id="password-hint" className="hint">
                {t('invite.passwordHint')}
              </p>
              <label htmlFor="confirm">{t('invite.passwordConfirm')}</label>
              <input
                id="confirm"
                name="confirm"
                type="password"
                required
                autoComplete="new-password"
              />
            </>
          )}
          <button type="submit" disabled={busy}>
            {t('common.continue')}
          </button>
        </form>
      )}

      {step.kind === 'scan' && (
        <section aria-labelledby="scan-title">
          <h2 id="scan-title">{t('invite.scanTitle')}</h2>
          <p>{t('invite.scanHelp')}</p>
          {step.qr && (
            <img
              className="qr"
              src={step.qr}
              width={220}
              height={220}
              alt={t('invite.scanTitle')}
            />
          )}
          <p className="hint">{t('invite.manualKey')}</p>
          <p className="key" data-testid="manual-key">
            {groupKey(step.secret)}
          </p>
          <CodeForm
            busy={busy}
            onSubmit={submitCode}
            label={t('invite.codeLabel')}
            submit={t('invite.finish')}
          />
        </section>
      )}

      {step.kind === 'confirm' && (
        <section aria-labelledby="confirm-title">
          <h2 id="confirm-title">{t('invite.confirmTitle')}</h2>
          <CodeForm
            busy={busy}
            onSubmit={submitCode}
            label={t('invite.codeLabel')}
            submit={t('invite.finish')}
          />
        </section>
      )}

      {step.kind === 'done' && (
        <div role="status">
          <p>{t('invite.done')}</p>
          <Link href="/clinic">{t('invite.goToDashboard')}</Link>
        </div>
      )}
    </div>
  );
}

function Summary({
  details,
  t,
  locale,
}: {
  details: InviteDetails;
  t: (key: MessageKey, params?: Record<string, string | number>) => string;
  locale: Locale;
}) {
  return (
    <div className="summary">
      <p>
        {t('invite.summary', {
          clinic: details.organisation.name,
          role: t(`role.${details.role}`),
        })}
      </p>
      <p className="hint">{t('invite.account', { identifier: details.identifier })}</p>
      <p className="hint">
        {t('invite.expires', { date: formatIstDateTime(details.expiresAt, locale) })}
      </p>
    </div>
  );
}

function CodeForm({
  busy,
  onSubmit,
  label,
  submit,
}: {
  busy: boolean;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void | Promise<void>;
  label: string;
  submit: string;
}) {
  return (
    <form onSubmit={(e) => void onSubmit(e)} noValidate>
      <label htmlFor="code">{label}</label>
      <input
        id="code"
        name="code"
        inputMode="numeric"
        pattern="[0-9]*"
        maxLength={7}
        autoComplete="one-time-code"
        required
      />
      <button type="submit" disabled={busy}>
        {submit}
      </button>
    </form>
  );
}
