'use client';

import { ApiError } from '@dhc/api-client';
import {
  checkUpload,
  MAX_RESULTS_PER_ORDER,
  OrganisationSettings,
  UPLOAD_MEDIA_TYPES,
  type PatientTestOrder,
  type TestOrder,
  type TestOrderStatus,
} from '@dhc/contracts';
import { formatIstDateTime, testOrderLabel } from '@dhc/domain';
import { Button, Surface, cn } from '@dhc/ui-web';
import { CheckCircle2, FileText, Upload } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSession } from '../session-provider';

const STATUS_LOOK: Record<TestOrderStatus, string> = {
  ordered: 'bg-info-soft text-info',
  result_uploaded: 'bg-warning-soft text-warning-foreground',
  reviewed: 'bg-success-soft text-success',
};

/** The file picker's types: the clinic's, once its settings load; every type until then. */
const acceptOf = (settings: OrganisationSettings | null) =>
  (settings
    ? settings.uploadTypes.flatMap((x) => UPLOAD_MEDIA_TYPES[x])
    : Object.values(UPLOAD_MEDIA_TYPES).flat()
  ).join(',');

/** The server's reasons for refusing a file, in the screen's language. */
const FILE_REASONS = [
  'type_not_allowed',
  'too_large',
  'type_mismatch',
  'empty',
  'too_many',
] as const;

/**
 * A patient's ordered tests on the profile (PRD §7.1): status, the results uploaded so far,
 * Upload result (front desk and doctors), and for doctors View result and Mark reviewed.
 * The front desk sees the tests but not the doctor's notes or the files.
 */
export function TestOrdersCard({ patientId, role }: { patientId: string; role: string }) {
  const { api, locale, signOut, t } = useSession();
  const { me } = useSession();
  const [orders, setOrders] = useState<PatientTestOrder[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [settings, setSettings] = useState<OrganisationSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Per order, so working on one row never freezes or unfreezes another.
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const doctor = role === 'doctor';
  const mark = (id: string, on: boolean) =>
    setBusy((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const fail = useCallback(
    (e: unknown) => {
      if (e instanceof ApiError && e.status === 401) return void signOut('expired');
      const reason = e instanceof ApiError ? e.fields.file : undefined;
      // Our wording needs the clinic's limits for these two; without the settings yet, the
      // server's own message (which names them) is shown instead.
      const needsSettings = reason === 'too_large' || reason === 'type_not_allowed';
      setError(
        e instanceof ApiError
          ? e.code === 'CHART_RESTRICTED'
            ? t('chart.restricted')
            : e.fields.status === 'reviewed'
              ? t('orders.alreadyReviewed')
              : reason &&
                  (FILE_REASONS as readonly string[]).includes(reason) &&
                  !(needsSettings && !settings)
                ? t(`orders.file.${reason as (typeof FILE_REASONS)[number]}`, {
                    max: MAX_RESULTS_PER_ORDER,
                    mb: settings?.maxUploadMb ?? 0,
                    types: settings?.uploadTypes.map((x) => x.toUpperCase()).join(', ') ?? '',
                  })
                : e.message
          : t('error.network'),
      );
    },
    [signOut, t, settings],
  );

  // Kept in a ref: `fail` changes when the settings arrive, which must not reload the list.
  const failRef = useRef(fail);
  useEffect(() => {
    failRef.current = fail;
  }, [fail]);

  const load = useCallback(async () => {
    try {
      const first = await api.patientTestOrders(patientId);
      setOrders(first.data);
      setNextCursor(first.nextCursor);
    } catch (e) {
      failRef.current(e);
    }
  }, [api, patientId]);

  async function more() {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const page = await api.patientTestOrders(patientId, nextCursor);
      setOrders((current) => [
        ...(current ?? []),
        ...page.data.filter((o) => !current?.some((c) => c.id === o.id)),
      ]);
      setNextCursor(page.nextCursor);
    } catch (e) {
      fail(e);
    } finally {
      setLoadingMore(false);
    }
  }

  /**
   * After a refusal (409: reviewed meanwhile, full, …) the row on screen is out of date:
   * fetch the pages already shown again until the order turns up, and put it back, so its
   * Upload and Mark reviewed buttons match what the server allows now.
   */
  async function refresh(id: string) {
    let cursor: string | undefined;
    try {
      for (let pages = 0; pages < 20; pages++) {
        const page = await api.patientTestOrders(patientId, cursor);
        const found = page.data.find((o) => o.id === id);
        if (found) {
          setOrders((current) => (current ?? []).map((o) => (o.id === id ? found : o)));
          return;
        }
        if (!page.nextCursor) return;
        cursor = page.nextCursor;
      }
    } catch (e) {
      // A failed refresh says so (and a lapsed session signs out) rather than leaving the
      // row silently stale.
      fail(e);
    }
  }
  const failFor = (id: string, e: unknown) => {
    fail(e);
    if (e instanceof ApiError && e.status === 409) void refresh(id);
  };

  /** Puts an order the API returned back in its row, keeping the list's own fields. */
  const replace = (updated: TestOrder, reviewedByName?: string | null) =>
    setOrders((current) =>
      (current ?? []).map((o) =>
        o.id === updated.id
          ? {
              ...o,
              ...updated,
              // The upload answer leaves the doctor's notes out for the front desk.
              notes: doctor ? updated.notes : o.notes,
              reviewedByName: reviewedByName === undefined ? o.reviewedByName : reviewedByName,
              canReview: doctor && updated.status === 'result_uploaded',
            }
          : o,
      ),
    );

  useEffect(() => {
    void load();
    api
      .request('GET', '/organisation-settings', { schema: OrganisationSettings })
      .then(setSettings)
      .catch(() => setSettings(null));
  }, [api, load]);

  async function upload(order: PatientTestOrder, file: File) {
    setError(null);
    setNotice(null);
    // The clinic's limits, before a long upload; the server checks again.
    const check = settings
      ? checkUpload(settings, { mediaType: file.type, sizeBytes: file.size })
      : 'ok';
    if (check === 'type_not_allowed') {
      return setError(
        t('orders.file.type_not_allowed', {
          types: settings!.uploadTypes.map((x) => x.toUpperCase()).join(', '),
        }),
      );
    }
    if (check === 'too_large') {
      return setError(t('orders.file.too_large', { mb: settings!.maxUploadMb }));
    }
    mark(order.id, true);
    try {
      replace(await api.uploadTestResult(order.id, file));
      setNotice(t('orders.uploaded'));
    } catch (e) {
      failFor(order.id, e);
    } finally {
      mark(order.id, false);
    }
  }

  async function review(order: PatientTestOrder) {
    setError(null);
    setNotice(null);
    mark(order.id, true);
    try {
      replace(await api.reviewTestOrder(order.id), me?.user.displayName ?? null);
    } catch (e) {
      failFor(order.id, e);
    } finally {
      mark(order.id, false);
    }
  }

  /** Opens a result in a new tab. The tab opens first, so the browser does not block it. */
  async function view(resultId: string) {
    const tab = window.open('', '_blank');
    try {
      const url = URL.createObjectURL(await api.testResultFile(resultId));
      if (tab) tab.location.href = url;
      else window.location.href = url;
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      tab?.close();
      fail(e);
    }
  }

  return (
    <Surface className="p-4 sm:p-6">
      <section aria-labelledby="test-orders-title" data-testid="test-orders">
        <h2 id="test-orders-title" className="mb-4 font-display text-lg font-bold">
          {t('orders.patientTitle')}
        </h2>
        {error && (
          <p
            role="alert"
            className="mb-3 rounded-xl bg-danger-soft px-4 py-3 text-sm text-destructive"
          >
            {error}
          </p>
        )}
        {notice && (
          <p
            role="status"
            className="mb-3 rounded-xl bg-success-soft px-4 py-3 text-sm text-success"
          >
            {notice}
          </p>
        )}
        {orders === null && !error && (
          <p aria-live="polite" className="text-sm text-muted-foreground">
            {t('common.loading')}
          </p>
        )}
        {orders?.length === 0 && (
          <p className="text-sm text-muted-foreground">{t('orders.none')}</p>
        )}
        {orders && orders.length > 0 && (
          <ul className="m-0 grid list-none gap-2 p-0">
            {orders.map((o) => (
              <OrderRow
                key={o.id}
                order={o}
                doctor={doctor}
                busy={busy.has(o.id)}
                accept={acceptOf(settings)}
                locale={locale}
                onUpload={(file) => void upload(o, file)}
                onReview={() => void review(o)}
                onView={(id) => void view(id)}
              />
            ))}
          </ul>
        )}
        {nextCursor && (
          <Button
            type="button"
            variant="outline"
            className="mt-3"
            disabled={loadingMore}
            onClick={() => void more()}
          >
            {loadingMore ? t('common.loading') : t('orders.more')}
          </Button>
        )}
      </section>
    </Surface>
  );
}

function OrderRow({
  order: o,
  doctor,
  busy,
  accept,
  locale,
  onUpload,
  onReview,
  onView,
}: {
  order: PatientTestOrder;
  doctor: boolean;
  busy: boolean;
  /** The file types the clinic accepts, for the picker. */
  accept: string;
  locale: 'en' | 'hi';
  onUpload(file: File): void;
  onReview(): void;
  onView(resultId: string): void;
}) {
  const { t } = useSession();
  const input = useRef<HTMLInputElement>(null);
  const label = testOrderLabel(o, locale);
  return (
    <li
      className="grid gap-2 rounded-xl border border-border px-3 py-3"
      data-testid={`test-order-${label}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="m-0 min-w-0 font-semibold [overflow-wrap:anywhere]">{label}</p>
        <span
          className={cn(
            'inline-flex min-h-6 items-center rounded-full px-2.5 py-0.5 text-xs font-semibold',
            STATUS_LOOK[o.status],
          )}
          data-testid="test-order-status"
        >
          {t(`orders.status.${o.status}`)}
        </span>
      </div>
      <p className="m-0 text-sm text-muted-foreground">
        {t('orders.orderedOn', {
          date: o.visitDate,
          doctor: o.doctorName ?? t('availability.doctor'),
        })}
        {o.reviewedAt && (
          <>
            {' · '}
            {t('orders.reviewedOn', {
              date: formatIstDateTime(o.reviewedAt, locale),
              name: o.reviewedByName ?? t('availability.doctor'),
            })}
          </>
        )}
      </p>
      {o.notes && <p className="m-0 text-sm">{o.notes}</p>}
      {o.results.length > 0 && (
        <ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-sm">
          {o.results.map((r, i) => {
            const text = `${t('orders.viewResult', { n: i + 1 })} · ${t(
              `orders.resultFrom.${r.uploadedBy}`,
              { date: formatIstDateTime(r.uploadedAt, locale) },
            )}`;
            return (
              <li key={r.id}>
                {doctor ? (
                  <Button
                    type="button"
                    variant="link"
                    className="h-auto px-0 py-1"
                    onClick={() => onView(r.id)}
                  >
                    <FileText aria-hidden />
                    {text}
                  </Button>
                ) : (
                  <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                    <FileText aria-hidden className="size-4" />
                    {text}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        {/* A review is final; a new result needs a new order. */}
        {o.status !== 'reviewed' && o.results.length < MAX_RESULTS_PER_ORDER && (
          <>
            <input
              ref={input}
              type="file"
              accept={accept}
              className="sr-only"
              aria-label={t('orders.uploadFor', { name: label })}
              tabIndex={-1}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) onUpload(file);
              }}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => input.current?.click()}
            >
              <Upload aria-hidden />
              {busy ? t('orders.uploading') : t('orders.upload')}
            </Button>
          </>
        )}
        {doctor && o.canReview && (
          <Button type="button" size="sm" disabled={busy} onClick={onReview}>
            <CheckCircle2 aria-hidden />
            {t('orders.markReviewed')}
          </Button>
        )}
      </div>
    </li>
  );
}
