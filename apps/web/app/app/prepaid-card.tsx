'use client';
import { PrepaidBookingView } from '@dhc/contracts';
import { formatInr } from '@dhc/domain';
import { Button, Surface } from '@dhc/ui-web';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { usePatientSession } from './session-provider';
import { Notice } from './parts';
import { portalErrorMessage } from '../../lib/patient';
/** A browser return never marks payment or booking successful. */
export function PrepaidCard({ id, onSettled }: { id: string; onSettled?: () => void }) {
  const { api, t, locale } = usePatientSession();
  const [view, setView] = useState<PrepaidBookingView | null>(null),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [confirmClose, setConfirmClose] = useState(false);
  const lock = useRef(false),
    serial = useRef(0);
  const load = useCallback(async () => {
    if (lock.current) return;
    const version = ++serial.current;
    try {
      const r = await api.request('GET', `/portal/prepaid-bookings/${id}`, {
        schema: PrepaidBookingView,
      });
      if (version !== serial.current) return;
      setView(r);
      setError(null);
      if (r.state !== 'held') onSettled?.();
    } catch (e) {
      if (version === serial.current) setError(portalErrorMessage(e, t));
    }
  }, [api, id, t, onSettled]);
  useEffect(() => {
    void load();
  }, [load]);
  // Read saved state only; explicit checks and the server sweep perform provider requests.
  const held = view?.state === 'held';
  useEffect(() => {
    if (!held) return;
    const timer = setInterval(() => void load(), 10000);
    return () => clearInterval(timer);
  }, [held, load]);
  const act = async (close = false) => {
    if (lock.current) return;
    lock.current = true;
    serial.current++;
    setBusy(true);
    setError(null);
    try {
      const r = await api.request(
        'POST',
        `/portal/prepaid-bookings/${id}/${close ? 'close' : 'check'}`,
        { schema: PrepaidBookingView },
      );
      setView(r);
      if (r.state !== 'held') onSettled?.();
      setConfirmClose(false);
    } catch (e) {
      setError(portalErrorMessage(e, t));
    } finally {
      setBusy(false);
      lock.current = false;
    }
  };
  return (
    <Surface className="space-y-4 p-5">
      <h2 className="font-semibold">{t('prepaid.title')}</h2>
      {error && <Notice tone="error">{error}</Notice>}
      {!view && (
        <Button disabled={busy} onClick={() => void load()}>
          {t('common.retry')}
        </Button>
      )}
      {view && (
        <>
          <p>{formatInr(view.amountPaise, locale)}</p>
          <p role="status">{t(`prepaid.state.${view.state}`)}</p>
          {view.state === 'confirmed' && view.appointmentStatus === 'confirmed' && (
            <p>{t('prepaid.bookingConfirmed')}</p>
          )}
          {view.state === 'confirmed' && view.appointmentStatus === 'pending' && (
            <p>{t('prepaid.awaitClinic')}</p>
          )}
          {view.state === 'held' && (
            <>
              <p>{t('prepaid.hold')}</p>
              <p>
                {t('prepaid.until', {
                  time: new Intl.DateTimeFormat(locale === 'hi' ? 'hi-IN' : 'en-IN', {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                    timeZone: 'Asia/Kolkata',
                  }).format(new Date(view.expiresAt)),
                })}
              </p>
              {(!view.providerAvailable || view.orderStatus === 'creating') && (
                <Notice tone="info">{t('prepaid.unavailable')}</Notice>
              )}
              {view.paymentUrl && Date.now() < Date.parse(view.expiresAt) && (
                <Button asChild>
                  <a href={view.paymentUrl} referrerPolicy="no-referrer">
                    {t('prepaid.pay')}
                  </a>
                </Button>
              )}
              <Button disabled={busy} variant="outline" onClick={() => void act()}>
                {t('prepaid.check')}
              </Button>
              {confirmClose ? (
                <div role="group" aria-label={t('prepaid.closeConfirm')}>
                  <p>{t('prepaid.closeConfirm')}</p>
                  <Button disabled={busy} variant="destructive" onClick={() => void act(true)}>
                    {t('prepaid.close')}
                  </Button>
                  <Button disabled={busy} variant="outline" onClick={() => setConfirmClose(false)}>
                    {t('common.cancel')}
                  </Button>
                </div>
              ) : (
                <Button variant="outline" disabled={busy} onClick={() => setConfirmClose(true)}>
                  {t('prepaid.close')}
                </Button>
              )}
            </>
          )}
          {view.state === 'review' && <p>{t('prepaid.review')}</p>}
          <Link className="block underline" href="/app/appointments">
            {t('patient.nav.appointments')}
          </Link>
        </>
      )}
    </Surface>
  );
}
