'use client';
import Link from 'next/link';
import { createApiClient } from '@dhc/api-client';
import type { PublicPayment } from '@dhc/contracts';
import { formatInr } from '@dhc/domain';
import { t as translate, type Locale, type MessageKey } from '@dhc/i18n';
import { Button, Surface, UiLocaleProvider } from '@dhc/ui-web';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { loadCashfree } from '../../../lib/cashfree-checkout';
export function PaymentPage({ token, apiBaseUrl }: { token: string; apiBaseUrl: string }) {
  const api = useMemo(() => createApiClient({ baseUrl: apiBaseUrl }), [apiBaseUrl]);
  const [locale, setLocale] = useState<Locale>('en'),
    [payment, setPayment] = useState<PublicPayment | null>(null),
    [error, setError] = useState(false),
    [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const t = (key: MessageKey) => translate(locale, key);
  const load = useCallback(async () => {
    setError(false);
    try {
      setPayment(await api.publicPaymentCheck(token));
    } catch {
      setError(true);
    }
  }, [api, token]);
  useEffect(() => {
    void load();
  }, [load]);
  async function act(pay: boolean) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(false);
    try {
      if (pay) {
        const factory = await loadCashfree();
        const checkout = await api.publicPaymentCheckout(token);
        await factory({ mode: checkout.environment }).checkout({
          paymentSessionId: checkout.paymentSessionId,
          redirectTarget: '_self',
        });
      }
      setPayment(await api.publicPaymentCheck(token));
    } catch {
      setError(true);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <UiLocaleProvider locale={locale}>
      <main className="grid min-h-dvh place-items-center bg-background p-4">
        <Surface className="w-full max-w-lg space-y-5 p-6">
          <div className="flex items-center justify-between gap-3">
            <h1 className="font-display text-2xl font-bold">{t('pay.title')}</h1>
            <Button variant="outline" onClick={() => setLocale(locale === 'en' ? 'hi' : 'en')}>
              {locale === 'en' ? 'हिन्दी' : 'English'}
            </Button>
          </div>
          {error && <p role="alert">{t('pay.error')}</p>}
          {!payment && (
            <Button disabled={busy} onClick={() => void load()}>
              {t(error ? 'common.retry' : 'common.loading')}
            </Button>
          )}
          {payment && (
            <>
              <Link className="block underline" href="/app/appointments">
                {t('patient.nav.appointments')}
              </Link>
              <h2 className="font-semibold">{payment.clinicName}</h2>
              <Link className="block underline" href="/app/payments">
                {t('finance.title')}
              </Link>
              <p className="text-3xl font-bold">{formatInr(payment.amountPaise, locale)}</p>
              <p role="status">{t(`pay.state.${payment.status}`)}</p>
              <p className="text-sm text-muted-foreground">{t('pay.intro')}</p>
              {payment.canPay &&
                payment.status === 'active' &&
                Date.now() < Date.parse(payment.expiresAt) && (
                  <Button disabled={busy} onClick={() => void act(true)}>
                    {t('pay.pay')}
                  </Button>
                )}
              {payment.status !== 'paid' && (
                <>
                  <p className="text-sm">{t('pay.pending')}</p>
                  <Button variant="outline" disabled={busy} onClick={() => void act(false)}>
                    {t('pay.check')}
                  </Button>
                </>
              )}
            </>
          )}
        </Surface>
      </main>
    </UiLocaleProvider>
  );
}
