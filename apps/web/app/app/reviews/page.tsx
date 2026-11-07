'use client';
import { ReviewConsent } from '@dhc/contracts';
import { Button, Surface } from '@dhc/ui-web';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { PatientLocaleToggle, usePatientSession } from '../session-provider';
/** Consent controls remain accessible without accepting health-data processing again. */
export default function Page() {
  const { api, status, t } = usePatientSession(),
    router = useRouter();
  const [value, setValue] = useState<ReviewConsent | null>(null),
    [agreed, setAgreed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      setValue(await api.request('GET', '/portal/review-consent', { schema: ReviewConsent }));
      setError('');
    } catch {
      setError(t('reviews.error'));
    }
  }, [api, t]);
  useEffect(() => {
    if (status === 'signedOut') router.replace('/app/login');
    if (status === 'signedIn') void load();
  }, [status, router, load]);
  async function save(enabled: boolean) {
    setBusy(true);
    setError('');
    try {
      setValue(
        await api.request('PUT', '/portal/review-consent', {
          schema: ReviewConsent,
          body: { enabled, recipientAgreed: agreed },
        }),
      );
      setAgreed(false);
    } catch {
      setError(t('reviews.error'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="mx-auto max-w-xl space-y-5 p-5">
      <div className="flex items-center justify-between">
        <Link href="/app" className="underline">
          {t('reviews.back')}
        </Link>
        <PatientLocaleToggle />
      </div>
      <h1 className="text-2xl font-bold">{t('reviews.consentTitle')}</h1>
      <Surface className="space-y-4 p-5">
        <p>{t('reviews.consentInfo')}</p>
        {error && (
          <p role="alert">
            {error}
            <Button onClick={() => void load()}>{t('reviews.refresh')}</Button>
          </p>
        )}
        {!value && !error && <p>{t('common.loading')}</p>}
        {value && (
          <>
            <p>{value.enabled ? t('reviews.consentOn') : t('reviews.consentOff')}</p>
            {value.enabled ? (
              <Button disabled={busy} variant="outline" onClick={() => void save(false)}>
                {t('reviews.optOut')}
              </Button>
            ) : (
              <>
                <label className="flex min-h-11 items-start gap-3">
                  <input
                    type="checkbox"
                    checked={agreed}
                    disabled={busy || !value.available}
                    onChange={(e) => setAgreed(e.target.checked)}
                  />
                  <span>{t('reviews.agree')}</span>
                </label>
                <Button
                  disabled={busy || !value.available || !agreed}
                  onClick={() => void save(true)}
                >
                  {t('reviews.optIn')}
                </Button>
                {!value.available && <p>{t('reviews.unavailable')}</p>}
              </>
            )}
          </>
        )}
      </Surface>
    </main>
  );
}
