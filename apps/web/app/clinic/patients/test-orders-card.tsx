'use client';

import { ApiError } from '@dhc/api-client';
import {
  checkUpload,
  OrganisationSettings,
  UPLOAD_MEDIA_TYPES,
  type PatientTestOrder,
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

const ACCEPT = Object.values(UPLOAD_MEDIA_TYPES).flat().join(',');

/**
 * A patient's ordered tests on the profile (PRD §7.1): status, the results uploaded so far,
 * Upload result (front desk and doctors), and for doctors View result and Mark reviewed.
 * The front desk sees the tests but not the doctor's notes or the files.
 */
export function TestOrdersCard({ patientId, role }: { patientId: string; role: string }) {
  const { api, locale, signOut, t } = useSession();
  const [orders, setOrders] = useState<PatientTestOrder[] | null>(null);
  const [settings, setSettings] = useState<OrganisationSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const doctor = role === 'doctor';

  const fail = useCallback(
    (e: unknown) => {
      if (e instanceof ApiError && e.status === 401) return void signOut('expired');
      setError(
        e instanceof ApiError
          ? e.code === 'CHART_RESTRICTED'
            ? t('chart.restricted')
            : e.message
          : t('error.network'),
      );
    },
    [signOut, t],
  );

  const load = useCallback(async () => {
    try {
      setOrders((await api.patientTestOrders(patientId)).data);
    } catch (e) {
      fail(e);
    }
  }, [api, patientId, fail]);

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
    setBusy(order.id);
    try {
      await api.uploadTestResult(order.id, file);
      setNotice(t('orders.uploaded'));
      await load();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  }

  async function review(order: PatientTestOrder) {
    setError(null);
    setNotice(null);
    setBusy(order.id);
    try {
      await api.reviewTestOrder(order.id);
      await load();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
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
                busy={busy === o.id}
                locale={locale}
                onUpload={(file) => void upload(o, file)}
                onReview={() => void review(o)}
                onView={(id) => void view(id)}
              />
            ))}
          </ul>
        )}
      </section>
    </Surface>
  );
}

function OrderRow({
  order: o,
  doctor,
  busy,
  locale,
  onUpload,
  onReview,
  onView,
}: {
  order: PatientTestOrder;
  doctor: boolean;
  busy: boolean;
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
        <input
          ref={input}
          type="file"
          accept={ACCEPT}
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
