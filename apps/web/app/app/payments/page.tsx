'use client';
import {
  PortalBill,
  PortalBillList,
  PortalReceiptList,
  type PortalReceiptSummary,
} from '@dhc/contracts';
import { formatInr, formatIstDateTime } from '@dhc/domain';
import { Button, Surface } from '@dhc/ui-web';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { PortalShell, type ReadyAccount } from '../shell';
import { usePatientSession } from '../session-provider';
import { PortalPage, PatientPicker, Notice } from '../parts';
import { portalErrorMessage } from '../../../lib/patient';
export default function Page() {
  return <PortalShell>{(a) => <Payments key={a.selected.id} account={a} />}</PortalShell>;
}
function Payments({ account: a }: { account: ReadyAccount }) {
  const { api, t, locale } = usePatientSession();
  const [bills, setBills] = useState<PortalBill[]>([]),
    [receipts, setReceipts] = useState<PortalReceiptSummary[]>([]),
    [billCursor, setBillCursor] = useState<string | null>(null),
    [receiptCursor, setReceiptCursor] = useState<string | null>(null),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [loaded, setLoaded] = useState(false);
  const requests = useRef(new Map<string, string>()),
    lock = useRef(false);
  const money = (n: number) => formatInr(n, locale),
    query = { patientId: a.selected.id, limit: 20 };
  const refresh = useCallback(async () => {
    const [b, r] = await Promise.all([
      api.request('GET', '/portal/bills', {
        schema: PortalBillList,
        query: { patientId: a.selected.id, limit: 20 },
      }),
      api.request('GET', '/portal/receipts', {
        schema: PortalReceiptList,
        query: { patientId: a.selected.id, limit: 20 },
      }),
    ]);
    setBills(b.data);
    setBillCursor(b.nextCursor);
    setReceipts(r.data);
    setReceiptCursor(r.nextCursor);
    setLoaded(true);
  }, [api, a.selected.id]);
  const work = useCallback(
    async (fn: () => Promise<void>) => {
      if (lock.current) return;
      lock.current = true;
      setBusy(true);
      setError(null);
      try {
        await fn();
      } catch (e) {
        setError(portalErrorMessage(e, t));
      } finally {
        lock.current = false;
        setBusy(false);
      }
    },
    [t],
  );
  useEffect(() => {
    void work(refresh);
  }, [work, refresh]);
  const pay = async (b: PortalBill) => {
    const id = b.order?.id ?? requests.current.get(b.id) ?? crypto.randomUUID();
    requests.current.set(b.id, id);
    await api.request('POST', `/portal/bills/${b.id}/checkout`, {
      schema: PortalBill,
      body: { id },
    });
    await refresh();
  };
  return (
    <PortalPage title={t('finance.title')} intro={t('finance.intro')}>
      <PatientPicker
        label={t('patient.home.switcher')}
        patients={a.patients}
        selectedId={a.selected.id}
        onSelect={a.select}
      />
      {error && <Notice tone="error">{error}</Notice>}
      <Button disabled={busy} variant="outline" onClick={() => void work(refresh)}>
        {t('finance.refresh')}
      </Button>
      <h2 className="font-display text-lg font-bold">{t('finance.bills')}</h2>
      {loaded && !bills.length && <p>{t('finance.noBills')}</p>}
      {bills.map((b) => (
        <Surface className="space-y-3 p-5" key={b.id} data-testid="portal-bill">
          <p className="font-semibold">
            {b.patient.name} · {b.visitDate}
          </p>
          <dl className="grid grid-cols-2 gap-2">
            {(
              [
                ['finance.total', b.totalPaise],
                ['finance.paid', b.paidPaise],
                ['finance.due', b.balancePaise],
                ['finance.refunded', b.refundedPaise],
                ['finance.net', b.netCollectedPaise],
              ] as const
            ).map(([k, n]) => (
              <div key={k}>
                <dt>{t(k)}</dt>
                <dd>{money(n)}</dd>
              </div>
            ))}
          </dl>
          {b.refundedPaise > 0 && <p className="text-sm">{t('finance.refundNote')}</p>}
          {b.prepaidBookingId ? (
            <Link className="block underline" href="/app/appointments">
              {t('finance.booking')}
            </Link>
          ) : (
            <>
              {b.canPay && !b.order?.paymentUrl && (
                <Button disabled={busy} onClick={() => void work(() => pay(b))}>
                  {t(b.order?.status === 'creating' ? 'finance.retryPayment' : 'finance.prepare')}
                </Button>
              )}
              {b.order?.paymentUrl && (
                <Button asChild>
                  <a href={b.order.paymentUrl} referrerPolicy="no-referrer">
                    {t('prepaid.pay')}
                  </a>
                </Button>
              )}
            </>
          )}
          {b.order && (
            <>
              <p>
                {t(
                  `pay.state.${b.order.status as 'creating' | 'active' | 'closing' | 'paid' | 'expired' | 'terminated' | 'review'}`,
                )}
              </p>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void work(async () => {
                    await api.request('POST', `/portal/bills/${b.id}/check`, {
                      schema: PortalBill,
                    });
                    await refresh();
                  })
                }
              >
                {t('pay.check')}
              </Button>
            </>
          )}
        </Surface>
      ))}
      {billCursor && (
        <Button
          disabled={busy}
          variant="outline"
          onClick={() =>
            void work(async () => {
              const r = await api.request('GET', '/portal/bills', {
                schema: PortalBillList,
                query: { ...query, cursor: billCursor },
              });
              setBills((old) => [...new Map([...old, ...r.data].map((b) => [b.id, b])).values()]);
              setBillCursor(r.nextCursor);
            })
          }
        >
          {t('finance.moreBills')}
        </Button>
      )}
      <h2 className="font-display text-lg font-bold">{t('finance.receipts')}</h2>
      {loaded && !receipts.length && <p>{t('finance.noReceipts')}</p>}
      {receipts.map((r) => (
        <Surface key={r.id} className="space-y-2 p-5" data-testid="portal-receipt">
          <h3 className="font-semibold">
            {r.receiptNumber} · {money(r.amountPaise)}
          </h3>
          <p>
            {r.patientName} · {formatIstDateTime(r.receivedAt, locale)} ·{' '}
            {t(`billing.mode.${r.mode}`)}
          </p>
          <Link className="underline" href={`/app/receipts/${r.id}`}>
            {t('finance.openReceipt')}
          </Link>
        </Surface>
      ))}
      {receiptCursor && (
        <Button
          disabled={busy}
          variant="outline"
          onClick={() =>
            void work(async () => {
              const r = await api.request('GET', '/portal/receipts', {
                schema: PortalReceiptList,
                query: { ...query, cursor: receiptCursor },
              });
              setReceipts((old) => [
                ...new Map([...old, ...r.data].map((p) => [p.id, p])).values(),
              ]);
              setReceiptCursor(r.nextCursor);
            })
          }
        >
          {t('finance.moreReceipts')}
        </Button>
      )}
    </PortalPage>
  );
}
