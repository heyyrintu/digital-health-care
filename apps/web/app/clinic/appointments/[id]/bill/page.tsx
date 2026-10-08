'use client';

import { ApiError } from '@dhc/api-client';
import {
  AppointmentDetail,
  Bill,
  BillView,
  MAX_BILL_ITEMS,
  Payment,
  PriceList,
  type PaymentMode,
  type PriceListItem,
  type SaveBillBody,
} from '@dhc/contracts';
import { billTotals, formatInr, rupeesToPaise } from '@dhc/domain';
import {
  Button,
  buttonVariants,
  cn,
  Input,
  Label,
  NativeSelect,
  PageHeader,
  Surface,
} from '@dhc/ui-web';
import { ArrowLeft, Receipt as ReceiptIcon, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { AgeGender } from '../../../patient-bits';
import { useSession } from '../../../session-provider';
import { ClinicShell, NotAllowed } from '../../../shell';

type Consultation = SaveBillBody['consultation'];
interface Draft {
  consultation: Consultation;
  items: { priceListItemId: string; quantity: number }[];
  discount: string;
  discountReason: string;
}

const MODES: PaymentMode[] = ['cash', 'upi', 'card'];
/** Visits that can be billed (the API's rule): the patient has arrived. */
const BILLABLE = ['checked_in', 'in_consultation', 'completed'];
const LABEL = 'block text-sm font-semibold';
const H2 = 'font-display text-lg font-bold';
const ALERT = 'rounded-xl bg-danger-soft px-4 py-3 text-sm font-medium text-destructive';
const NOTICE = 'rounded-xl bg-info-soft px-4 py-3 text-sm text-info';

/** A visit's bill and its counter payments (PRD §5.6): front desk and doctors. */
export default function BillPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <ClinicShell>
      {(me) => (me.role === 'patient' ? <NotAllowed /> : <BillScreen key={id} id={id} />)}
    </ClinicShell>
  );
}

function draftOf(bill: Bill | null): Draft {
  if (!bill) return { consultation: 'consultation', items: [], discount: '', discountReason: '' };
  const fee = bill.lines.find((l) => l.kind !== 'item');
  return {
    consultation: fee ? (fee.kind as Consultation) : 'none',
    items: bill.lines
      .filter((l) => l.kind === 'item' && l.priceListItemId)
      .map((l) => ({ priceListItemId: l.priceListItemId!, quantity: l.quantity })),
    discount: bill.discountPaise ? String(bill.discountPaise / 100) : '',
    discountReason: bill.discountReason ?? '',
  };
}

function BillScreen({ id }: { id: string }) {
  const { api, locale, signOut, t } = useSession();
  const [appointment, setAppointment] = useState<AppointmentDetail | null>(null);
  const [view, setView] = useState<BillView | null>(null);
  const [prices, setPrices] = useState<PriceListItem[]>([]);
  const [draft, setDraft] = useState<Draft>(draftOf(null));
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Only the latest load may set the screen, so a slow reload cannot undo a newer one.
  const latest = useRef(0);

  const fail = useCallback(
    (e: unknown) => {
      if (e instanceof ApiError && e.status === 401) return void signOut('expired');
      if (e instanceof ApiError && e.fields.revision === 'stale') return void setStale(true);
      setError(e instanceof ApiError ? e.message : t('error.network'));
    },
    [signOut, t],
  );

  const load = useCallback(async () => {
    const request = ++latest.current;
    setError(null);
    setStale(false);
    const path = `/appointments/${encodeURIComponent(id)}`;
    const [a, v, p] = await Promise.all([
      api.request('GET', path, { schema: AppointmentDetail }),
      api.request('GET', `${path}/bill`, { schema: BillView }),
      api.request('GET', '/price-list', { schema: PriceList }),
    ]);
    if (request !== latest.current) return;
    setAppointment(a);
    setView(v);
    setPrices(p.data);
    setDraft(draftOf(v.bill));
  }, [api, id]);

  useEffect(() => {
    load().catch(fail);
  }, [load, fail]);

  // As the server prices them: a line already on the bill keeps its billed price, a new
  // line takes today's fee or price-list price.
  const priceOf = useMemo(() => {
    const map = new Map(prices.map((p) => [p.id, { name: p.name, unitPaise: p.pricePaise }]));
    for (const l of view?.bill?.lines ?? []) {
      if (l.priceListItemId) map.set(l.priceListItemId, { name: l.name, unitPaise: l.unitPaise });
    }
    return map;
  }, [prices, view]);
  const feeOf = useCallback(
    (kind: Consultation): number | null => {
      if (!view || kind === 'none') return null;
      const line = view.bill?.lines.find((l) => l.kind === kind);
      if (line) return line.unitPaise;
      return kind === 'follow_up' ? view.followUpFeePaise : view.feePaise;
    },
    [view],
  );
  const fee = feeOf(draft.consultation);

  // The same sum the server makes when the bill is saved.
  const preview = useMemo(() => {
    const lines = [
      ...(fee === null ? [] : [{ unitPaise: fee, quantity: 1 }]),
      ...draft.items.flatMap((i) => {
        const p = priceOf.get(i.priceListItemId);
        return p ? [{ unitPaise: p.unitPaise, quantity: i.quantity }] : [];
      }),
    ];
    const discount = draft.discount ? Math.round(Number(draft.discount) * 100) : 0;
    try {
      return billTotals(lines, Number.isSafeInteger(discount) ? discount : 0);
    } catch {
      return null;
    }
  }, [draft, fee, priceOf]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void run(async () => {
      const discountPaise = draft.discount ? rupeesToPaise(Number(draft.discount)) : 0;
      await api.request('PUT', `/appointments/${encodeURIComponent(id)}/bill`, {
        schema: Bill,
        body: {
          revision: view?.bill?.revision ?? 0,
          consultation: draft.consultation,
          items: draft.items,
          discountPaise,
          discountReason: discountPaise > 0 ? draft.discountReason.trim() || null : null,
        },
      });
      await load();
      setNotice(t('billing.saved'));
    });
  }

  const blocker =
    view && appointment
      ? view.bill && view.bill.paidPaise > 0
        ? t('billing.locked')
        : view.canEdit
          ? null
          : BILLABLE.includes(appointment.status)
            ? t('billing.viewOnly')
            : t('billing.cannotBill')
      : null;

  const setItems = (items: Draft['items']) => setDraft({ ...draft, items });
  const available = prices.filter(
    (p) => p.active && !draft.items.some((i) => i.priceListItemId === p.id),
  );

  const header = appointment && (
    <PageHeader
      title={t('billing.pageTitle', { name: appointment.patient.name })}
      sub={
        <>
          <span className="tabular">{appointment.patient.uhid}</span> ·{' '}
          <AgeGender patient={appointment.patient} /> ·{' '}
          <span className="font-semibold text-foreground">
            {t('queue.token', { token: appointment.tokenNumber })}
          </span>{' '}
          · {appointment.doctorName ?? t('availability.doctor')}
        </>
      }
    />
  );

  return (
    <section className="mx-auto max-w-3xl space-y-5">
      <p>
        <Link
          href={`/clinic/queue${appointment ? `?date=${appointment.date}` : ''}`}
          className="inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          <ArrowLeft className="size-4" aria-hidden />
          {t('consult.back')}
        </Link>
      </p>
      {error && (
        <p role="alert" className={ALERT}>
          {error}
        </p>
      )}
      {stale && (
        <p role="alert" className={cn(ALERT, 'flex flex-wrap items-center gap-x-2')}>
          {t('billing.stale')}
          <Button type="button" variant="link" className="px-1" onClick={() => void load()}>
            {t('consult.reload')}
          </Button>
        </p>
      )}
      {notice && (
        <p role="status" className="rounded-xl bg-success-soft px-4 py-3 text-sm text-success">
          {notice}
        </p>
      )}

      {!appointment || !view ? (
        !error && (
          <p aria-live="polite" className="text-sm text-muted-foreground">
            {t('common.loading')}
          </p>
        )
      ) : (
        <>
          {header}
          <Surface className="space-y-5 p-5 sm:p-6">
            {blocker && <p className={NOTICE}>{blocker}</p>}

            {view.canEdit ? (
              <form className="space-y-5" onSubmit={save}>
                <fieldset className="m-0 space-y-2 border-0 p-0">
                  <legend className={cn(LABEL, 'mb-2')}>{t('billing.consultationTitle')}</legend>
                  {(
                    [
                      [
                        'consultation',
                        t('billing.consultationFee', {
                          fee: formatInr(feeOf('consultation') ?? 0, locale),
                        }),
                      ],
                      ...(feeOf('follow_up') !== null
                        ? ([
                            [
                              'follow_up',
                              t('billing.followUpFee', {
                                fee: formatInr(feeOf('follow_up') ?? 0, locale),
                              }),
                            ],
                          ] as const)
                        : []),
                      ['none', t('billing.noConsultationFee')],
                    ] as const
                  ).map(([value, label]) => (
                    <label key={value} className="flex min-h-11 items-center gap-2.5 text-sm">
                      <input
                        type="radio"
                        name="consultation"
                        value={value}
                        className="size-4 accent-primary"
                        checked={draft.consultation === value}
                        onChange={() => setDraft({ ...draft, consultation: value })}
                      />
                      {label}
                    </label>
                  ))}
                  <p className="text-xs text-muted-foreground">{view.consultationTypeName}</p>
                </fieldset>

                <div className="space-y-3 border-t border-border pt-5">
                  <h2 className={LABEL}>{t('billing.itemsTitle')}</h2>
                  {draft.items.length > 0 && (
                    <ul className="space-y-2" data-testid="bill-items">
                      {draft.items.map((line) => {
                        const p = priceOf.get(line.priceListItemId);
                        const name = p?.name ?? '—';
                        return (
                          <li
                            key={line.priceListItemId}
                            className="flex flex-wrap items-center gap-3 rounded-xl border border-border px-3 py-2"
                          >
                            <span className="min-w-0 flex-1 font-medium">{name}</span>
                            <span className="tabular text-sm text-muted-foreground">
                              {p ? formatInr(p.unitPaise, locale) : ''} ×
                            </span>
                            <Input
                              type="number"
                              min={1}
                              max={99}
                              step={1}
                              className="tabular w-20"
                              aria-label={t('billing.quantity', { name })}
                              value={line.quantity}
                              onChange={(e) => {
                                const quantity = Number(e.target.value);
                                if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99)
                                  return;
                                setItems(
                                  draft.items.map((i) =>
                                    i.priceListItemId === line.priceListItemId
                                      ? { ...i, quantity }
                                      : i,
                                  ),
                                );
                              }}
                            />
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              aria-label={t('billing.removeItem', { name })}
                              onClick={() =>
                                setItems(
                                  draft.items.filter(
                                    (i) => i.priceListItemId !== line.priceListItemId,
                                  ),
                                )
                              }
                            >
                              <Trash2 aria-hidden />
                            </Button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  {prices.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t('billing.noPriceList')}</p>
                  ) : (
                    available.length > 0 &&
                    draft.items.length < MAX_BILL_ITEMS && (
                      <div className="w-full space-y-1.5 sm:w-80">
                        <Label htmlFor="bill-add-item" className={LABEL}>
                          {t('billing.addFromList')}
                        </Label>
                        <NativeSelect
                          id="bill-add-item"
                          value=""
                          onChange={(e) => {
                            if (!e.target.value) return;
                            setItems([
                              ...draft.items,
                              { priceListItemId: e.target.value, quantity: 1 },
                            ]);
                          }}
                        >
                          <option value="">{t('billing.chooseItem')}</option>
                          {available.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name} · {formatInr(p.pricePaise, locale)}
                            </option>
                          ))}
                        </NativeSelect>
                      </div>
                    )
                  )}
                </div>

                <div className="grid gap-3 border-t border-border pt-5 sm:grid-cols-[10rem_minmax(0,1fr)]">
                  <div className="space-y-1.5">
                    <Label htmlFor="bill-discount" className={LABEL}>
                      {t('billing.discount')}
                    </Label>
                    <Input
                      id="bill-discount"
                      type="number"
                      min={0}
                      step="0.01"
                      className="tabular"
                      value={draft.discount}
                      onChange={(e) => setDraft({ ...draft, discount: e.target.value })}
                    />
                  </div>
                  {Number(draft.discount) > 0 && (
                    <div className="space-y-1.5">
                      <Label htmlFor="bill-discount-reason" className={LABEL}>
                        {t('billing.discountReason')}
                      </Label>
                      <Input
                        id="bill-discount-reason"
                        required
                        maxLength={200}
                        value={draft.discountReason}
                        onChange={(e) => setDraft({ ...draft, discountReason: e.target.value })}
                      />
                    </div>
                  )}
                </div>

                <Totals
                  rows={[
                    [t('billing.subtotal'), preview?.subtotal],
                    [t('billing.discountLine'), preview ? -preview.discount : undefined],
                    [t('billing.total'), preview?.total, true],
                  ]}
                />
                <Button
                  type="submit"
                  disabled={
                    busy ||
                    stale ||
                    preview === null ||
                    (draft.consultation === 'none' && draft.items.length === 0)
                  }
                >
                  {t('billing.save')}
                </Button>
              </form>
            ) : (
              view.bill && <SavedBill bill={view.bill} />
            )}
          </Surface>

          <Payments view={view} busy={busy} run={run} reload={load} setNotice={setNotice} />
        </>
      )}
    </section>
  );
}

/** Subtotal, discount and total; amounts in paise (negative shows as a deduction). */
function Totals({ rows }: { rows: [string, number | undefined, boolean?][] }) {
  const { locale } = useSession();
  return (
    <dl className="space-y-1.5 border-t border-border pt-4 text-sm" data-testid="bill-totals">
      {rows.map(([label, amount, strong]) => (
        <div
          key={label}
          className={cn('flex justify-between gap-4', strong && 'text-base font-bold')}
        >
          <dt>{label}</dt>
          <dd className="tabular">
            {amount === undefined
              ? '—'
              : amount < 0
                ? `− ${formatInr(-amount, locale)}`
                : formatInr(amount, locale)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function SavedBill({ bill }: { bill: Bill }) {
  const { locale, t } = useSession();
  return (
    <div className="space-y-4">
      <ul className="divide-y divide-border/70" data-testid="bill-lines">
        {bill.lines.map((line) => (
          <li key={line.id} className="flex flex-wrap justify-between gap-x-4 py-2.5 text-sm">
            <span className="font-medium">
              {line.name}
              {line.quantity > 1 && (
                <span className="tabular text-muted-foreground">
                  {' '}
                  · {formatInr(line.unitPaise, locale)} × {line.quantity}
                </span>
              )}
            </span>
            <span className="tabular">{formatInr(line.amountPaise, locale)}</span>
          </li>
        ))}
      </ul>
      {bill.discountReason && (
        <p className="text-xs text-muted-foreground">{bill.discountReason}</p>
      )}
      <Totals
        rows={[
          [t('billing.subtotal'), bill.subtotalPaise],
          [t('billing.discountLine'), -bill.discountPaise],
          [t('billing.total'), bill.totalPaise, true],
          [t('billing.paid'), bill.paidPaise],
          [t('billing.balance'), bill.balancePaise, true],
        ]}
      />
    </div>
  );
}

function Payments({
  view,
  busy,
  run,
  reload,
  setNotice,
}: {
  view: BillView;
  busy: boolean;
  run(action: () => Promise<void>): Promise<void>;
  reload(): Promise<void>;
  setNotice(notice: string): void;
}) {
  const { api, locale, t } = useSession();
  const bill = view.bill;
  const [mode, setMode] = useState<PaymentMode>('cash');
  // Kept until the payment is recorded, so a retry after a dropped connection is the
  // same payment and is never taken twice.
  const [paymentId, setPaymentId] = useState(() => crypto.randomUUID());

  function record(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!bill) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const reference = String(data.get('reference') ?? '').trim();
    void run(async () => {
      const payment = await api.request('POST', `/bills/${bill.id}/payments`, {
        schema: Payment,
        body: {
          id: paymentId,
          mode,
          amountPaise: rupeesToPaise(Number(data.get('amount'))),
          reference: mode === 'cash' || !reference ? null : reference,
        },
      });
      // Only once the screen shows it: if the reload fails, a retry is still this payment.
      await reload();
      setPaymentId(crypto.randomUUID());
      form.reset();
      setNotice(t('billing.paymentSaved', { number: payment.receiptNumber }));
    });
  }

  return (
    <Surface className="space-y-4 p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="payments-title" className={H2}>
          {t('billing.paymentsTitle')}
        </h2>
        {bill && (
          <span className="tabular text-sm font-semibold" data-testid="bill-status">
            {t(`billing.status.${bill.status}`)} · {t('billing.balance')}{' '}
            {formatInr(bill.balancePaise, locale)}
          </span>
        )}
      </div>
      {!bill || bill.payments.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {bill ? t('billing.noPayments') : t('billing.saveFirst')}
        </p>
      ) : (
        <ul className="divide-y divide-border/70" data-testid="payments">
          {bill.payments.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
              <span className="tabular text-sm">
                {t('billing.paymentLine', {
                  amount: formatInr(p.amountPaise, locale),
                  mode: t(`billing.mode.${p.mode}`),
                  number: p.receiptNumber,
                })}
              </span>
              <Link
                href={`/clinic/receipts/${p.id}`}
                className={buttonVariants({ variant: 'outline', size: 'sm' })}
              >
                <ReceiptIcon aria-hidden />
                {t('billing.receipt')} {p.receiptNumber}
              </Link>
            </li>
          ))}
        </ul>
      )}

      {view.canPay && bill && (
        <form
          className="grid gap-3 border-t border-border pt-4 sm:grid-cols-2"
          onSubmit={record}
          key={bill.paidPaise}
        >
          <fieldset className="m-0 space-y-2 border-0 p-0 sm:col-span-2">
            <legend className={cn(LABEL, 'mb-2')}>{t('billing.mode')}</legend>
            <div className="inline-flex flex-wrap gap-1 rounded-xl bg-muted p-1">
              {MODES.map((m) => (
                <label
                  key={m}
                  className={cn(
                    'inline-flex min-h-10 cursor-pointer items-center rounded-lg px-4 text-sm font-semibold has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring',
                    mode === m ? 'bg-card text-foreground shadow-xs' : 'text-muted-foreground',
                  )}
                >
                  <input
                    type="radio"
                    name="mode"
                    value={m}
                    className="sr-only"
                    checked={mode === m}
                    onChange={() => setMode(m)}
                  />
                  {t(`billing.mode.${m}`)}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="space-y-1.5">
            <Label htmlFor="pay-amount" className={LABEL}>
              {t('billing.amount')}
            </Label>
            <Input
              id="pay-amount"
              name="amount"
              type="number"
              min={0.01}
              max={bill.balancePaise / 100}
              step="0.01"
              required
              className="tabular"
              defaultValue={bill.balancePaise / 100}
            />
          </div>
          {mode !== 'cash' && (
            <div className="space-y-1.5">
              <Label htmlFor="pay-reference" className={LABEL}>
                {t('billing.reference')}
              </Label>
              <Input id="pay-reference" name="reference" maxLength={60} />
            </div>
          )}
          <Button type="submit" disabled={busy} className="sm:col-span-2 sm:justify-self-start">
            {t('billing.recordPayment')}
          </Button>
        </form>
      )}
    </Surface>
  );
}
