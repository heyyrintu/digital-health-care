'use client';

import { ApiError, createApiClient } from '@dhc/api-client';
import type { InviteDetails } from '@dhc/contracts';
import { formatIstDateTime } from '@dhc/domain';
import { t as translate, type Locale, type MessageKey } from '@dhc/i18n';
import { Button, Input, Label, Surface, UiLocaleProvider, buttonVariants, cn } from '@dhc/ui-web';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
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
import { postSession, type SessionTokens } from '../../lib/session-client';

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
  const router = useRouter();
  const token = useRef<string | null>(null);
  const [locale, setLocale] = useState<Locale>('en');

  // Screen readers and spell-checkers follow the page language.
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
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
        // Completed through this site's session route, so the person lands signed in.
        await postSession<SessionTokens>('invite', { token: token.current, code });
        token.current = null;
        setStep({ kind: 'done' });
        router.replace('/clinic');
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return setStep({ kind: 'invalid' });
        if (e instanceof ApiError && e.status === 401) return setError(t('invite.codeInvalid'));
        setError(messageFor(e));
      }
    });
  }

  const stage =
    step.kind === 'password' ? 1 : step.kind === 'scan' || step.kind === 'confirm' ? 2 : 3;
  const showStages = step.kind !== 'loading' && step.kind !== 'missing' && step.kind !== 'invalid';

  return (
    <UiLocaleProvider locale={locale}>
      <Surface className="w-full max-w-md p-6 sm:p-8" lang={locale}>
        <div className="flex items-start justify-between gap-3">
          <h1 className="font-display text-2xl font-extrabold leading-tight">
            {'details' in step && step.details.purpose === 'reset'
              ? t('invite.resetTitle')
              : t('invite.title')}
          </h1>
          <Button
            type="button"
            variant="link"
            className="-mr-2 shrink-0 px-2"
            onClick={() => setLocale(locale === 'en' ? 'hi' : 'en')}
            lang={locale === 'en' ? 'hi' : 'en'}
          >
            {locale === 'en' ? 'हिंदी' : 'English'}
          </Button>
        </div>

        {showStages && (
          <ol className="mt-4 flex gap-1.5" aria-hidden="true">
            {[1, 2, 3].map((n) => (
              <li
                key={n}
                className={cn('h-1.5 flex-1 rounded-full', n <= stage ? 'bg-primary' : 'bg-muted')}
              />
            ))}
          </ol>
        )}

        <div className="mt-6 space-y-5">
          {error && (
            <p
              role="alert"
              className="rounded-xl bg-danger-soft px-3.5 py-2.5 text-sm font-medium text-destructive"
            >
              {error}
            </p>
          )}

          {step.kind === 'loading' && !error && (
            <p aria-live="polite" className="text-sm text-muted-foreground">
              {t('invite.loading')}
            </p>
          )}
          {step.kind === 'missing' && (
            <p
              role="alert"
              className="rounded-xl bg-danger-soft px-3.5 py-2.5 text-sm font-medium text-destructive"
            >
              {t('invite.missingToken')}
            </p>
          )}
          {step.kind === 'invalid' && (
            <p
              role="alert"
              className="rounded-xl bg-danger-soft px-3.5 py-2.5 text-sm font-medium text-destructive"
            >
              {t('invite.invalid')}
            </p>
          )}

          {(step.kind === 'password' || step.kind === 'scan' || step.kind === 'confirm') && (
            <Summary details={step.details} t={t} locale={locale} />
          )}

          {step.kind === 'password' && (
            <form
              onSubmit={(e) => void submitPassword(e, step.details)}
              noValidate
              className="space-y-4"
            >
              {step.details.account === 'existing' && (
                <p className="text-sm text-muted-foreground">{t('invite.existingIntro')}</p>
              )}
              <div className="space-y-1.5">
                <Label htmlFor="password">
                  {step.details.account === 'new'
                    ? t('invite.passwordNew')
                    : t('invite.passwordExisting')}
                </Label>
                <Input
                  id="password"
                  name="password"
                  type="password"
                  required
                  minLength={step.details.account === 'new' ? MIN_PASSWORD_LENGTH : 1}
                  autoComplete={
                    step.details.account === 'new' ? 'new-password' : 'current-password'
                  }
                  aria-describedby={step.details.account === 'new' ? 'password-hint' : undefined}
                />
                {step.details.account === 'new' && (
                  <p id="password-hint" className="text-xs text-muted-foreground">
                    {t('invite.passwordHint')}
                  </p>
                )}
              </div>
              {step.details.account === 'new' && (
                <div className="space-y-1.5">
                  <Label htmlFor="confirm">{t('invite.passwordConfirm')}</Label>
                  <Input
                    id="confirm"
                    name="confirm"
                    type="password"
                    required
                    autoComplete="new-password"
                  />
                </div>
              )}
              <Button type="submit" disabled={busy} size="lg" className="w-full">
                {t('common.continue')}
              </Button>
            </form>
          )}

          {step.kind === 'scan' && (
            <section aria-labelledby="scan-title" className="space-y-4">
              <div>
                <h2 id="scan-title" className="font-display text-lg font-bold">
                  {t('invite.scanTitle')}
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">{t('invite.scanHelp')}</p>
              </div>
              {step.qr && (
                <img
                  className="qr mx-auto block rounded-xl border border-border bg-card p-2"
                  src={step.qr}
                  width={220}
                  height={220}
                  alt={t('invite.scanTitle')}
                />
              )}
              <div className="rounded-xl bg-muted px-4 py-3">
                <p className="text-xs text-muted-foreground">{t('invite.manualKey')}</p>
                <p
                  className="key mt-1 select-all break-all text-center font-mono text-base font-semibold tracking-wider tabular"
                  data-testid="manual-key"
                >
                  {groupKey(step.secret)}
                </p>
              </div>
              <CodeForm
                busy={busy}
                onSubmit={submitCode}
                label={t('invite.codeLabel')}
                submit={t('invite.finish')}
              />
            </section>
          )}

          {step.kind === 'confirm' && (
            <section aria-labelledby="confirm-title" className="space-y-4">
              <h2 id="confirm-title" className="font-display text-lg font-bold">
                {t('invite.confirmTitle')}
              </h2>
              <CodeForm
                busy={busy}
                onSubmit={submitCode}
                label={t('invite.codeLabel')}
                submit={t('invite.finish')}
              />
            </section>
          )}

          {step.kind === 'done' && (
            <div
              role="status"
              className="space-y-4 rounded-xl bg-success-soft px-4 py-4 text-sm text-success"
            >
              <p className="font-medium">{t('invite.done')}</p>
              <Link href="/clinic" className={buttonVariants({ className: 'w-full' })}>
                {t('invite.goToDashboard')}
              </Link>
            </div>
          )}
        </div>
      </Surface>
    </UiLocaleProvider>
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
    <div className="summary space-y-1 rounded-xl border border-border bg-accent/40 px-4 py-3">
      <p className="text-sm font-medium">
        {details.purpose === 'reset'
          ? t('invite.resetSummary', { clinic: details.organisation.name })
          : t('invite.summary', {
              clinic: details.organisation.name,
              role: t(`role.${details.role}`),
            })}
      </p>
      <p className="text-xs text-muted-foreground">
        {t('invite.account', { identifier: details.identifier })}
      </p>
      <p className="text-xs text-muted-foreground">
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
    <form onSubmit={(e) => void onSubmit(e)} noValidate className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="code">{label}</Label>
        <Input
          id="code"
          className="tabular text-center font-mono text-lg tracking-[0.3em] md:text-lg"
          name="code"
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={7}
          autoComplete="one-time-code"
          required
        />
      </div>
      <Button type="submit" disabled={busy} size="lg" className="w-full">
        {submit}
      </Button>
    </form>
  );
}
