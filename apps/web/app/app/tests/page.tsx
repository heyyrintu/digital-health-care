'use client';

import {
  appendPage,
  canUploadResult,
  fileSize,
  findOrder,
  InFlight,
  isStale,
  replaceRow,
  resultFileName,
  shareTypeOf,
  withUploaded,
} from '@dhc/api-client';
import {
  MAX_RESULTS_PER_ORDER,
  MAX_UPLOAD_MB,
  type PortalTestOrder,
  type TestOrderStatus,
  type TestResultSummary,
} from '@dhc/contracts';
import { istDateKey, shortDate, testOrderLabel } from '@dhc/domain';
import { Button, cn, EmptyState } from '@dhc/ui-web';
import { Download, FileText, Upload } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  checkChosenFile,
  consentRequired,
  portalErrorMessage,
  UPLOAD_ACCEPT,
  uploadFailureText,
} from '../../../lib/patient';
import { canShowInBrowser, openFile } from '../../../lib/patient-files';
import { BlockedDownload, LoadError, Loading, Notice, PortalPage } from '../parts';
import { usePatientSession } from '../session-provider';
import { PortalShell } from '../shell';

/**
 * PRD §4.4, §7.1: the family's ordered tests, newest first, with their status and the
 * results so far. A result (a PDF or a photo) can be uploaded until the doctor has reviewed
 * the test, and every result opens in a new tab like a prescription PDF.
 */
export default function TestsPage() {
  return <PortalShell>{() => <Tests />}</PortalShell>;
}

type ListState =
  | { status: 'loading' }
  | { status: 'error'; error: unknown }
  | { status: 'ready'; rows: PortalTestOrder[]; nextCursor: string | null };

type RowNotice =
  | { tone: 'success' | 'error'; text: string }
  /** The browser blocked the result's tab: a link to download it instead. */
  | { tone: 'blocked'; url: string; name: string };

const STATUS_LOOK: Record<TestOrderStatus, string> = {
  ordered: 'bg-info-soft text-info',
  result_uploaded: 'bg-warning-soft text-warning-foreground',
  reviewed: 'bg-success-soft text-success',
};

function Tests() {
  const { api, account, files, locale, t } = usePatientSession();
  const [state, setState] = useState<ListState>({ status: 'loading' });
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  // Per test, so an upload on one row never freezes or unfreezes another.
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [notices, setNotices] = useState<Readonly<Record<string, RowNotice>>>({});
  /** The one result being downloaded; the other View buttons wait for it. */
  const [opening, setOpening] = useState<string | null>(null);
  const run = useRef(0);
  const inFlight = useRef(new InFlight());

  const mark = (id: string, on: boolean) =>
    setBusy((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const say = (id: string, notice: RowNotice | null) =>
    setNotices((current) => {
      const next = { ...current };
      if (notice) next[id] = notice;
      else delete next[id];
      return next;
    });
  const setRow = (next: PortalTestOrder) =>
    setState((s) => (s.status === 'ready' ? { ...s, rows: replaceRow(s.rows, next) } : s));

  const load = useCallback(async () => {
    const id = ++run.current;
    setState({ status: 'loading' });
    setMoreError(null);
    setNotices({});
    try {
      const first = await api.portalTestOrders();
      if (id === run.current) {
        setState({ status: 'ready', rows: first.data, nextCursor: first.nextCursor });
      }
    } catch (error) {
      if (id === run.current) setState({ status: 'error', error });
    }
  }, [api]);
  useEffect(() => void load(), [load]);

  async function more() {
    if (state.status !== 'ready' || !state.nextCursor) return;
    const id = run.current;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await api.portalTestOrders(state.nextCursor);
      if (id !== run.current) return;
      setState((s) =>
        s.status === 'ready'
          ? { status: 'ready', rows: appendPage(s.rows, page.data), nextCursor: page.nextCursor }
          : s,
      );
    } catch (e) {
      if (id === run.current) setMoreError(portalErrorMessage(e, t));
    } finally {
      setLoadingMore(false);
    }
  }

  /** After a 409 the row is out of date: put the server's copy back, so its buttons match. */
  async function refresh(orderId: string) {
    try {
      const found = await findOrder((cursor) => api.portalTestOrders(cursor), orderId);
      // Only a fresh copy replaces the row; otherwise it stays, with the refusal's message.
      if (typeof found === 'object') setRow(found);
    } catch {
      // The refusal's message is already showing; the next visit to the page reloads.
    }
  }

  async function upload(order: PortalTestOrder, file: File) {
    // A PDF or a photo within 25 MB, before a long upload; the server checks again.
    const check = checkChosenFile(file, t);
    if ('text' in check) return say(order.id, { tone: 'error', text: check.text });
    if (!inFlight.current.start(order.id)) return;
    say(order.id, null);
    mark(order.id, true);
    try {
      // Sent as the type checked here: some browsers give HEIC photos no type at all.
      const updated = await api.uploadPortalTestResult(
        order.id,
        file.slice(0, file.size, check.mediaType),
      );
      setState((s) => {
        if (s.status !== 'ready') return s;
        const row = s.rows.find((o) => o.id === order.id);
        return row ? { ...s, rows: replaceRow(s.rows, withUploaded(row, updated)) } : s;
      });
      say(order.id, { tone: 'success', text: t('orders.uploaded') });
    } catch (e) {
      say(order.id, { tone: 'error', text: uploadFailureText(e, t) });
      // A consent withdrawn elsewhere sends the person back to the consents screen.
      if (consentRequired(e)) void account.reload();
      if (isStale(e)) void refresh(order.id);
    } finally {
      inFlight.current.end(order.id);
      mark(order.id, false);
    }
  }

  // Set synchronously, so a double click opens the result once.
  const viewing = useRef(false);
  async function view(order: PortalTestOrder, result: TestResultSummary, n: number) {
    if (viewing.current) return;
    viewing.current = true;
    setOpening(result.id);
    say(order.id, null);
    try {
      const outcome = await openFile(
        () => api.portalTestResultFile(result.id),
        { name: resultFileName(n, result.mediaType), mediaType: result.mediaType },
        files,
      );
      if (outcome.kind === 'blocked') say(order.id, { tone: 'blocked', ...outcome });
      // A result the browser was to show came back as something else: it was saved instead.
      else if (outcome.kind === 'saved' && canShowInBrowser(result.mediaType)) {
        say(order.id, { tone: 'success', text: t('portal.files.saved') });
      }
    } catch (e) {
      say(order.id, { tone: 'error', text: portalErrorMessage(e, t) });
    } finally {
      viewing.current = false;
      setOpening(null);
    }
  }

  const dayOf = (at: string) => shortDate(istDateKey(at), locale);

  return (
    <PortalPage title={t('patient.nav.tests')} intro={t('patient.tests.intro')}>
      {state.status === 'loading' && <Loading />}
      {state.status === 'error' && <LoadError error={state.error} retry={() => void load()} />}
      {state.status === 'ready' &&
        (state.rows.length === 0 ? (
          <EmptyState title={t('orders.none')} />
        ) : (
          <>
            <p className="text-sm text-muted-foreground" id="upload-limit">
              {t('portal.tests.limit', { mb: MAX_UPLOAD_MB })}
            </p>
            <ul className="space-y-3" data-testid="test-orders">
              {state.rows.map((o) => (
                <TestRow
                  key={o.id}
                  order={o}
                  busy={busy.has(o.id)}
                  opening={opening}
                  notice={notices[o.id]}
                  dayOf={dayOf}
                  onUpload={(file) => void upload(o, file)}
                  onView={(r, n) => void view(o, r, n)}
                />
              ))}
            </ul>
            {moreError && <Notice tone="error">{moreError}</Notice>}
            {state.nextCursor && (
              <Button
                type="button"
                variant="outline"
                disabled={loadingMore}
                onClick={() => void more()}
              >
                {loadingMore ? t('common.loading') : t('orders.more')}
              </Button>
            )}
          </>
        ))}
    </PortalPage>
  );
}

function TestRow({
  order: o,
  busy,
  opening,
  notice,
  dayOf,
  onUpload,
  onView,
}: {
  order: PortalTestOrder;
  busy: boolean;
  opening: string | null;
  notice: RowNotice | undefined;
  dayOf: (at: string) => string;
  onUpload(file: File): void;
  onView(result: TestResultSummary, n: number): void;
}) {
  const { locale, t } = usePatientSession();
  const input = useRef<HTMLInputElement>(null);
  const label = testOrderLabel(o, locale);
  return (
    <li className="surface space-y-1 p-4 text-sm" data-testid="test-order">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-display text-base font-bold">{o.patient.name}</p>
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
      <p className="font-medium [overflow-wrap:anywhere]">{label}</p>
      <p className="text-muted-foreground">
        {o.doctorName ? `${o.doctorName} · ` : ''}
        {shortDate(o.visitDate, locale)}
      </p>
      {o.notes && (
        <p className="text-xs text-muted-foreground">
          {t('patient.tests.notes', { notes: o.notes })}
        </p>
      )}
      {o.reviewedAt && (
        <p className="text-xs text-muted-foreground">
          {t('patient.tests.reviewed', { date: dayOf(o.reviewedAt) })}
        </p>
      )}
      {o.results.length > 0 && (
        <ul className="space-y-1 pt-1">
          {o.results.map((r, i) => {
            const shown = canShowInBrowser(r.mediaType);
            return (
              <li
                key={r.id}
                className="flex flex-wrap items-center justify-between gap-2"
                data-testid="test-result"
              >
                <span className="min-w-0 text-muted-foreground">
                  {shareTypeOf(r.mediaType).label ?? t('patient.tests.fileType')} ·{' '}
                  {fileSize(r.sizeBytes)} ·{' '}
                  {t(
                    r.uploadedBy === 'patient'
                      ? 'patient.tests.byPatient'
                      : 'patient.tests.byClinic',
                    {
                      date: dayOf(r.uploadedAt),
                    },
                  )}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={opening !== null}
                  aria-busy={opening === r.id}
                  aria-label={t(shown ? 'portal.tests.viewFor' : 'portal.tests.downloadFor', {
                    n: i + 1,
                    name: label,
                  })}
                  onClick={() => onView(r, i + 1)}
                >
                  {shown ? <FileText aria-hidden /> : <Download aria-hidden />}
                  {t(shown ? 'patient.tests.view' : 'portal.tests.download', { n: i + 1 })}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      {canUploadResult(o) ? (
        <div className="pt-2">
          <input
            ref={input}
            type="file"
            accept={UPLOAD_ACCEPT}
            className="sr-only"
            // The button below is what people and screen readers use; this only opens the chooser.
            aria-hidden
            tabIndex={-1}
            disabled={busy}
            onChange={(e) => {
              const file = e.target.files?.[0];
              // Cleared, so choosing the same file again (after an error) still uploads.
              e.target.value = '';
              if (file) onUpload(file);
            }}
          />
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            aria-busy={busy}
            aria-label={t('orders.uploadFor', { name: label })}
            aria-describedby="upload-limit"
            onClick={() => input.current?.click()}
          >
            <Upload aria-hidden />
            {busy ? t('orders.uploading') : t('orders.upload')}
          </Button>
        </div>
      ) : (
        o.status !== 'reviewed' && (
          <p className="text-xs text-muted-foreground">
            {t('patient.tests.full', { max: MAX_RESULTS_PER_ORDER })}
          </p>
        )
      )}
      {/* Always present, so screen readers announce what goes in it. */}
      <div aria-live="polite" className="empty:hidden pt-2" data-testid="test-order-notice">
        {notice &&
          (notice.tone === 'blocked' ? (
            <BlockedDownload url={notice.url} name={notice.name} />
          ) : (
            <Notice tone={notice.tone}>{notice.text}</Notice>
          ))}
      </div>
    </li>
  );
}
