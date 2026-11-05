'use client';
import { ApiError } from '@dhc/api-client';
import { RefundReason, type Bill, type CreateRefundBody, type RefundView } from '@dhc/contracts';
import { formatInr, rupeesToPaise } from '@dhc/domain';
import { Button, Input, Label, NativeSelect, Surface } from '@dhc/ui-web';
import Link from 'next/link';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useSession } from '../../../session-provider';
export function RefundCard({ bill, onChange }: { bill: Bill; onChange: () => Promise<void> }) {
  const { api, me, t, locale, signOut } = useSession();
  const [view, setView] = useState<RefundView | null>(null),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  const [paymentId, setPaymentId] = useState(''),
    [amount, setAmount] = useState(''),
    [reason, setReason] = useState('');
  const [confirmation, setConfirmation] = useState<{
    paymentId: string;
    body: CreateRefundBody;
    receipt: string;
    submitted?: boolean;
  } | null>(null);
  const lock = useRef(false),
    formId = useId();
  const eligible = bill.payments.some((p) => p.mode === 'cashfree');
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
  const load = useCallback(async () => {
    try {
      setView(await api.refunds(bill.id));
    } catch (e) {
      fail(e);
    }
  }, [api, bill.id, fail]);
  useEffect(() => {
    if (eligible) void load();
  }, [load, eligible, bill.refundedPaise]);
  async function run(action: () => Promise<RefundView>, creating = false) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    if (creating) setConfirmation((value) => (value ? { ...value, submitted: true } : value));
    try {
      setView(await action());
      setConfirmation(null);
      setAmount('');
      await onChange();
    } catch (e) {
      fail(e);
      await load();
      // Keep the same request UUID after an ambiguous response; a second partial refund must be explicit.
      if (!creating || (e instanceof ApiError && e.status < 500)) setConfirmation(null);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  function prepare() {
    const paise = /^\d{1,6}(?:\.\d{1,2})?$/.test(amount) ? rupeesToPaise(Number(amount)) : null,
      selected = view?.payments.find((p) => p.id === paymentId),
      parsed = RefundReason.safeParse(reason);
    if (
      paise === null ||
      paise <= 0 ||
      !selected ||
      paise > selected.refundablePaise ||
      selected.hasPending ||
      !parsed.success
    ) {
      setError(t('refund.invalid'));
      return;
    }
    setError(null);
    setConfirmation({
      paymentId,
      receipt: selected.receiptNumber,
      body: { id: crypto.randomUUID(), amountPaise: paise, reason: parsed.data },
    });
  }
  if (!eligible) return null;
  const selected = view?.payments.find((p) => p.id === paymentId);
  return (
    <Surface className="space-y-4 p-5" data-testid="refund-card">
      <h2 className="font-display text-lg font-bold">{t('refund.title')}</h2>
      <p className="text-sm text-muted-foreground">{t('refund.note')}</p>
      {error && <p role="alert">{error}</p>}
      {!view && (
        <Button variant="outline" onClick={() => void load()}>
          {t(error ? 'common.retry' : 'common.loading')}
        </Button>
      )}
      {view && (
        <>
          <p>
            {t('refund.total')}: {formatInr(view.refundedPaise, locale)}
          </p>
          {view.pendingPaise > 0 && (
            <p>
              {t('refund.pending')}: {formatInr(view.pendingPaise, locale)}
            </p>
          )}
          {view.reviewRequired && <p role="alert">{t('refund.review')}</p>}
          {!view.refunds.length && <p>{t('refund.none')}</p>}
          <ul className="divide-y divide-border">
            {view.refunds.map((r) => (
              <li key={r.id} className="space-y-2 py-3" data-testid="refund-row">
                <p>{formatInr(r.amountPaise, locale)}</p>
                <p role="status">{t(`refund.state.${r.status}`)}</p>
                <div className="flex flex-wrap gap-2">
                  {view.available && (
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => void run(() => api.checkRefund(r.id))}
                    >
                      {t('refund.check')}
                    </Button>
                  )}
                  {view.enabled &&
                    me?.role === 'clinic_admin' &&
                    r.status === 'creating' &&
                    r.origin === 'app' && (
                      <Button
                        variant="outline"
                        disabled={busy}
                        onClick={() => void run(() => api.retryRefund(r.id))}
                      >
                        {t('refund.retry')}
                      </Button>
                    )}
                  {r.voucherNumber && (
                    <Link className="text-primary underline" href={`/clinic/refunds/${r.id}`}>
                      {r.voucherNumber}
                    </Link>
                  )}
                </div>
              </li>
            ))}
          </ul>
          {view.available &&
            view.payments.map((p) => (
              <Button
                key={p.id}
                variant="outline"
                disabled={busy}
                onClick={() => void run(() => api.syncRefunds(p.id))}
              >
                {t('refund.sync')} · {p.receiptNumber}
              </Button>
            ))}
          {view.enabled && me?.role === 'clinic_admin' && !view.reviewRequired && (
            <div className="space-y-3">
              <Label htmlFor={formId + '-payment'}>{t('refund.original')}</Label>
              <NativeSelect
                id={formId + '-payment'}
                value={paymentId}
                disabled={busy || !!confirmation}
                onChange={(e) => {
                  setPaymentId(e.target.value);
                  setAmount('');
                }}
              >
                <option value="">—</option>
                {view.payments
                  .filter((p) => p.refundablePaise > 0 && !p.hasPending)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.receiptNumber}
                    </option>
                  ))}
              </NativeSelect>
              {selected && (
                <p>
                  {t('refund.refundable', { amount: formatInr(selected.refundablePaise, locale) })}
                </p>
              )}
              <Label htmlFor={formId + '-amount'}>{t('refund.amount')}</Label>
              <Input
                id={formId + '-amount'}
                inputMode="decimal"
                value={amount}
                disabled={busy || !!confirmation}
                onChange={(e) => setAmount(e.target.value)}
              />
              <Label htmlFor={formId + '-reason'}>{t('refund.reason')}</Label>
              <NativeSelect
                id={formId + '-reason'}
                value={reason}
                disabled={busy || !!confirmation}
                onChange={(e) => setReason(e.target.value)}
              >
                <option value="">{t('refund.choose')}</option>
                {RefundReason.options.map((r) => (
                  <option key={r} value={r}>
                    {t(`refund.reason.${r}`)}
                  </option>
                ))}
              </NativeSelect>
              {confirmation ? (
                <div className="space-y-3" role="group" aria-label={t('refund.confirm')}>
                  <p>
                    {t('refund.confirmText', {
                      amount: formatInr(confirmation.body.amountPaise, locale),
                      receipt: confirmation.receipt,
                    })}
                  </p>
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void run(
                        () => api.createRefund(confirmation.paymentId, confirmation.body),
                        true,
                      )
                    }
                  >
                    {t(confirmation.submitted ? 'refund.retry' : 'refund.confirm')}
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy || confirmation.submitted}
                    onClick={() => setConfirmation(null)}
                  >
                    {t('common.cancel')}
                  </Button>
                </div>
              ) : (
                <Button disabled={busy} onClick={prepare}>
                  {t('refund.request')}
                </Button>
              )}
            </div>
          )}
        </>
      )}
    </Surface>
  );
}
