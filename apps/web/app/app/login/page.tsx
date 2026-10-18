'use client';

import type { OtpRequestResponse } from '@dhc/contracts';
import { Button, Checkbox, Field, Input } from '@dhc/ui-web';
import { HeartPulse } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState, type FormEvent } from 'react';
import { isSixDigitCode } from '../../../lib/invite';
import {
  clinicSlug,
  isClinicSlug,
  isIndianMobile,
  portalErrorMessage,
  signedInDestination,
} from '../../../lib/patient';
import { postPatientSession, type SessionTokens } from '../../../lib/session-client';
import { Notice } from '../parts';
import { PatientLocaleToggle, usePatientSession } from '../session-provider';

/** The clinic this browser signed in to last (a convenience, never a credential). */
const LAST_CLINIC_KEY = 'dhc.patientClinic';

export default function PatientLoginPage() {
  return (
    <Suspense>
      <Login />
    </Suspense>
  );
}

/** Patient sign-in (PRD §4.1): clinic and mobile number, then the 6-digit code sent by SMS. */
function Login() {
  const { status, endedReason, me, signOut, startSession, t } = usePatientSession();
  const router = useRouter();
  const params = useSearchParams();
  const [clinic, setClinic] = useState('');
  const [phone, setPhone] = useState('');
  const [challenge, setChallenge] = useState<string | null>(null);
  const [code, setCode] = useState('');
  // Off by default: on a shared computer the session ends when the browser closes.
  const [keep, setKeep] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [invalid, setInvalid] = useState<'clinic' | 'phone' | 'code' | null>(null);

  // From the clinic's link (`/app/login?clinic=<id>`), else the last sign-in here.
  useEffect(() => {
    let remembered = '';
    try {
      remembered = window.localStorage.getItem(LAST_CLINIC_KEY) ?? '';
    } catch {
      // Storage unavailable (private mode): the field just starts empty.
    }
    setClinic(params.get('clinic') ?? remembered);
  }, [params]);

  // Signed in (or already), on to the page that sent the patient here: a doctor's public
  // page sends `next=/app/book?doctor=<slug>`. Only portal pages are followed, and never
  // into a session at another clinic than the link's.
  const destination =
    status === 'signedIn' && me
      ? signedInDestination(me.organisation.slug, params.get('clinic'), params.get('next'))
      : null;
  const goTo = destination && 'go' in destination ? destination.go : null;
  useEffect(() => {
    if (goTo) router.replace(goTo);
  }, [goTo, router]);

  async function sendCode(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (!isClinicSlug(clinic)) {
      setInvalid('clinic');
      return setError(t('portal.clinicInvalid'));
    }
    if (!isIndianMobile(phone)) {
      setInvalid('phone');
      return setError(t('portal.phoneInvalid'));
    }
    setBusy(true);
    setError(null);
    setInvalid(null);
    try {
      const { challengeId } = await postPatientSession<OtpRequestResponse>('otp/request', {
        organisation: clinicSlug(clinic),
        phone: phone.trim(),
      });
      try {
        window.localStorage.setItem(LAST_CLINIC_KEY, clinicSlug(clinic));
      } catch {
        // Not remembered; sign-in goes on.
      }
      setChallenge(challengeId);
      setCode('');
    } catch (e) {
      setError(portalErrorMessage(e, t));
    } finally {
      setBusy(false);
    }
  }

  async function verify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!challenge) return;
    const digits = code.replace(/\s/g, '');
    if (!isSixDigitCode(digits)) {
      setInvalid('code');
      return setError(t('mobile.codeInvalid'));
    }
    setBusy(true);
    setError(null);
    setInvalid(null);
    try {
      // Signed in, the effect above moves on to the portal.
      await startSession(
        await postPatientSession<SessionTokens>('otp/verify', {
          challengeId: challenge,
          code: digits,
          keep,
        }),
        { keep },
      );
    } catch (e) {
      setInvalid('code');
      setError(portalErrorMessage(e, t));
    } finally {
      setBusy(false);
    }
  }

  const notice =
    endedReason === 'idle'
      ? t('session.idleSignedOut')
      : endedReason === 'expired'
        ? t('session.expired')
        : endedReason === 'offline'
          ? t('error.network')
          : null;

  return (
    <main className="grid min-h-dvh place-items-center bg-hero px-4 py-10 font-sans text-foreground">
      <div className="surface w-full max-w-md p-6 sm:p-8">
        <div className="mb-6 flex items-start justify-between gap-3">
          <span
            className="grid h-12 w-12 place-items-center rounded-2xl bg-primary text-primary-foreground shadow-button"
            aria-hidden
          >
            <HeartPulse className="size-6" />
          </span>
          <PatientLocaleToggle />
        </div>
        <p className="text-[11px] font-bold uppercase tracking-wide text-primary">
          {t('portal.title')}
        </p>
        <h1 className="mt-1 font-display text-2xl font-extrabold">
          {t('mobile.patientSignIn.title')}
        </h1>

        <div className="mb-5 mt-4 space-y-3">
          {notice && !error && <Notice tone="info">{notice}</Notice>}
          {error && <Notice tone="error">{error}</Notice>}
        </div>

        {destination && 'otherClinic' in destination ? (
          <div className="space-y-4" data-testid="other-clinic">
            <Notice tone="info">
              {t('portal.otherClinic', {
                current: me!.organisation.name,
                clinic: destination.otherClinic,
              })}
            </Notice>
            <Button type="button" size="lg" className="w-full" onClick={() => void signOut('user')}>
              {t('session.signOut')}
            </Button>
          </div>
        ) : challenge === null ? (
          <form className="space-y-4" onSubmit={(e) => void sendCode(e)} noValidate>
            <p className="text-sm text-muted-foreground">{t('mobile.patientSignIn.intro')}</p>
            <Field label={t('login.clinic')} hint={t('login.clinicHint')}>
              <Input
                name="organisation"
                value={clinic}
                onChange={(e) => setClinic(e.target.value)}
                aria-invalid={invalid === 'clinic' ? true : undefined}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                required
              />
            </Field>
            <Field
              label={t('mobile.patientSignIn.phone')}
              hint={t('mobile.patientSignIn.phoneHint')}
            >
              <Input
                name="phone"
                type="tel"
                inputMode="tel"
                autoComplete="tel-national"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                aria-invalid={invalid === 'phone' ? true : undefined}
                maxLength={20}
                required
              />
            </Field>
            <Button type="submit" size="lg" className="w-full" disabled={busy}>
              {t('mobile.patientSignIn.sendCode')}
            </Button>
          </form>
        ) : (
          <form className="space-y-4" onSubmit={(e) => void verify(e)} noValidate>
            <p className="text-sm text-muted-foreground" role="status">
              {t('mobile.patientSignIn.codeSent', { phone: phone.trim() })}
            </p>
            <Field label={t('mobile.patientSignIn.codeLabel')}>
              <Input
                name="code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                aria-invalid={invalid === 'code' ? true : undefined}
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={7}
                autoComplete="one-time-code"
                className="tabular text-center text-lg tracking-[0.3em]"
                autoFocus
                required
              />
            </Field>
            <div className="space-y-1">
              <label className="flex cursor-pointer items-start gap-3 text-sm">
                <Checkbox
                  className="mt-0.5"
                  checked={keep}
                  onCheckedChange={(on) => setKeep(on === true)}
                  aria-describedby="keep-hint"
                />
                <span>{t('portal.keepSignedIn')}</span>
              </label>
              <p id="keep-hint" className="pl-8 text-xs text-muted-foreground">
                {t('portal.keepSignedInHint')}
              </p>
            </div>
            <Button type="submit" size="lg" className="w-full" disabled={busy}>
              {t('login.verify')}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="w-full"
              disabled={busy}
              onClick={() => void sendCode()}
            >
              {t('mobile.patientSignIn.resend')}
            </Button>
            <Button
              type="button"
              variant="link"
              className="w-full"
              disabled={busy}
              onClick={() => {
                setChallenge(null);
                setError(null);
                setInvalid(null);
              }}
            >
              {t('mobile.patientSignIn.changeNumber')}
            </Button>
          </form>
        )}
      </div>
    </main>
  );
}
