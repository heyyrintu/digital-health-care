'use client';
import { ApiError } from '@dhc/api-client';
import type { Bill, OnlinePaymentView } from '@dhc/contracts';
import { formatInr } from '@dhc/domain';
import { Button, Input, Label, Surface } from '@dhc/ui-web';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSession } from '../../../session-provider';
export function OnlinePaymentCard({
  bill,
  onChange,
  bookingPayment = false,
}: {
  bill: Bill;
  bookingPayment?: boolean;
  onChange: () => Promise<void>;
}) {
  const { api, me, t, locale, signOut } = useSession();
  const [view, setView] = useState<OnlinePaymentView | null>(null),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [confirm, setConfirm] = useState(false);
  const requestId = useRef<string | null>(null);
  const fail = useCallback(
    (e: unknown) => {
      if (e instanceof ApiError && e.status === 401) {
        void signOut('expired');
        return;
      }
      setError(e instanceof ApiError ? e.message : t('error.network'));
    },
    [signOut, t],
  );
  const load = useCallback(
    () => api.onlinePayment(bill.id).then(setView).catch(fail),
    [api, bill.id, fail],
  );
  useEffect(() => {
    void load();
  }, [load, bill.revision]);
  async function run(action: 'create' | 'check' | 'close') {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (action === 'create') {
        requestId.current ??= crypto.randomUUID();
        setView(await api.createOnlinePayment(bill.id, requestId.current));
        requestId.current = null;
      } else if (view?.order)
        setView(await api.checkOnlinePayment(view.order.id, action === 'close'));
      setConfirm(false);
      await onChange();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }
  if (view && !view.available && !view.order) return null;
  const order = view?.order,
    open = order && ['creating', 'active', 'closing', 'review'].includes(order.status);
  const canCreate =
    !bookingPayment &&
    view?.available &&
    view.acceptingPayments &&
    !open &&
    bill.balancePaise >= 100 &&
    (me?.role === 'doctor' || me?.role === 'front_desk');
  return (
    <Surface className="space-y-3 p-5" data-testid="online-payment">
      <h2 className="font-display text-lg font-bold">{t('pay.title')}</h2>
      {error && <p role="alert">{error}</p>}
      {!view && (
        <Button variant="outline" onClick={() => void load()}>
          {t(error ? 'common.retry' : 'common.loading')}
        </Button>
      )}
      {order && (
        <>
          <p role="status">{t(`pay.state.${order.status}`)}</p>
          {order.reviewRequired && <p role="alert">{t('pay.state.review')}</p>}
          <p>{formatInr(order.amountPaise, locale)}</p>
          {open && <p className="text-sm text-muted-foreground">{t('pay.hold')}</p>}
          {order.status === 'active' && order.paymentUrl && (
            <div className="space-y-2">
              <Label htmlFor="online-payment-link">{t('pay.link')}</Label>
              <Input id="online-payment-link" readOnly value={order.paymentUrl} />
              <a
                href={order.paymentUrl}
                target="_blank"
                rel="noreferrer"
                className="block text-primary underline"
              >
                {t('pay.open')}
              </a>
            </div>
          )}
          {view?.available && (
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" disabled={busy} onClick={() => void run('check')}>
                {t('pay.check')}
              </Button>
              {open && (
                <Button variant="outline" disabled={busy} onClick={() => setConfirm(true)}>
                  {t('pay.close')}
                </Button>
              )}
            </div>
          )}
          {confirm && (
            <div className="space-y-2">
              <p>{t('pay.closeConfirm')}</p>
              <Button disabled={busy} onClick={() => void run('close')}>
                {t('pay.close')}
              </Button>
              <Button variant="outline" disabled={busy} onClick={() => setConfirm(false)}>
                {t('common.cancel')}
              </Button>
            </div>
          )}
          {order.paymentId && (
            <Link className="text-primary underline" href={`/clinic/receipts/${order.paymentId}`}>
              {t('billing.receipt')}
            </Link>
          )}
        </>
      )}
      {canCreate && (
        <Button disabled={busy} onClick={() => void run('create')}>
          {t('pay.create')}
        </Button>
      )}
    </Surface>
  );
}
