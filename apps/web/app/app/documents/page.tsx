'use client';

import { fileSize, shareTypeOf } from '@dhc/api-client';
import { documentFileName, type PortalDocument } from '@dhc/contracts';
import { istDateKey, shortDate } from '@dhc/domain';
import { Button, EmptyState } from '@dhc/ui-web';
import { Download, FileText } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { portalErrorMessage } from '../../../lib/patient';
import { canShowInBrowser, openFile } from '../../../lib/patient-files';
import { BlockedDownload, LoadError, Loading, Notice, PortalPage } from '../parts';
import { usePatientSession } from '../session-provider';
import { PortalShell } from '../shell';

/**
 * PRD §7.3: the documents doctors shared with the family (exercise sheets, diet charts,
 * reports), newest first. Each opens in a new tab like a prescription PDF, through the
 * session's file registry (closed and revoked at sign-out); one not opened yet is marked
 * New. A document the doctor withdrew no longer shows.
 */
export default function DocumentsPage() {
  return <PortalShell>{() => <Documents />}</PortalShell>;
}

type ListState =
  | { status: 'loading' }
  | { status: 'error'; error: unknown }
  | { status: 'ready'; rows: PortalDocument[]; nextCursor: string | null };

type RowNotice =
  | { tone: 'success' | 'error'; text: string }
  /** The browser blocked the document's tab: a link to download it instead. */
  | { tone: 'blocked'; url: string; name: string };

function Documents() {
  const { api, files, t } = usePatientSession();
  const [state, setState] = useState<ListState>({ status: 'loading' });
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [notices, setNotices] = useState<Readonly<Record<string, RowNotice>>>({});
  /** The one document being downloaded; the other buttons wait for it. */
  const [opening, setOpening] = useState<string | null>(null);
  const run = useRef(0);

  const say = (id: string, notice: RowNotice | null) =>
    setNotices((current) => {
      const next = { ...current };
      if (notice) next[id] = notice;
      else delete next[id];
      return next;
    });

  const load = useCallback(async () => {
    const id = ++run.current;
    setState({ status: 'loading' });
    setMoreError(null);
    setNotices({});
    try {
      const first = await api.portalDocuments();
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
      const page = await api.portalDocuments(state.nextCursor);
      if (id !== run.current) return;
      setState((s) =>
        s.status === 'ready'
          ? {
              status: 'ready',
              // A document shared meanwhile can move one along a page: list it once.
              rows: [...s.rows, ...page.data.filter((d) => !s.rows.some((r) => r.id === d.id))],
              nextCursor: page.nextCursor,
            }
          : s,
      );
    } catch (e) {
      if (id === run.current) setMoreError(portalErrorMessage(e, t));
    } finally {
      setLoadingMore(false);
    }
  }

  // Set synchronously, so a double click opens the document once.
  const viewing = useRef(false);
  async function view(doc: PortalDocument, n: number) {
    if (viewing.current) return;
    viewing.current = true;
    setOpening(doc.id);
    say(doc.id, null);
    try {
      const outcome = await openFile(
        () => api.portalDocumentFile(doc.id),
        { name: documentFileName(n, doc.mediaType), mediaType: doc.mediaType },
        files,
      );
      if (outcome.kind === 'blocked') say(doc.id, { tone: 'blocked', ...outcome });
      else if (outcome.kind === 'saved' && canShowInBrowser(doc.mediaType)) {
        say(doc.id, { tone: 'success', text: t('portal.files.saved') });
      }
      if (outcome.kind !== 'ended') {
        // Opened: no longer new.
        setState((s) =>
          s.status === 'ready'
            ? { ...s, rows: s.rows.map((r) => (r.id === doc.id ? { ...r, isNew: false } : r)) }
            : s,
        );
      }
    } catch (e) {
      say(doc.id, { tone: 'error', text: portalErrorMessage(e, t) });
    } finally {
      viewing.current = false;
      setOpening(null);
    }
  }

  return (
    <PortalPage title={t('patient.nav.documents')} intro={t('portal.documents.intro')}>
      {state.status === 'loading' && <Loading />}
      {state.status === 'error' && <LoadError error={state.error} retry={() => void load()} />}
      {state.status === 'ready' &&
        (state.rows.length === 0 ? (
          <EmptyState title={t('portal.documents.none')} />
        ) : (
          <>
            <ul className="space-y-3" data-testid="portal-documents">
              {state.rows.map((d, i) => (
                <DocumentRow
                  key={d.id}
                  doc={d}
                  opening={opening}
                  notice={notices[d.id]}
                  onView={() => void view(d, i + 1)}
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
                {loadingMore ? t('common.loading') : t('documents.more')}
              </Button>
            )}
          </>
        ))}
    </PortalPage>
  );
}

function DocumentRow({
  doc: d,
  opening,
  notice,
  onView,
}: {
  doc: PortalDocument;
  opening: string | null;
  notice: RowNotice | undefined;
  onView(): void;
}) {
  const { locale, t } = usePatientSession();
  const shown = canShowInBrowser(d.mediaType);
  const date = shortDate(istDateKey(d.sharedAt), locale);
  return (
    <li className="surface space-y-1 p-4 text-sm" data-testid="portal-document">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-display text-base font-bold">{d.patient.name}</p>
        {d.isNew && (
          <span
            className="inline-flex min-h-6 items-center rounded-full bg-info-soft px-2.5 py-0.5 text-xs font-semibold text-info"
            data-testid="document-new"
          >
            {t('portal.documents.new')}
          </span>
        )}
      </div>
      <p className="font-medium [overflow-wrap:anywhere]">{d.title}</p>
      <p className="text-muted-foreground">
        {d.doctorName
          ? t('portal.documents.from', { name: d.doctorName, date })
          : t('portal.documents.fromClinic', { date })}
        {d.category ? ` · ${t(`documents.category.${d.category}`)}` : ''}
      </p>
      {d.note && (
        <p className="whitespace-pre-line text-xs text-muted-foreground">
          {t('portal.documents.note', { note: d.note })}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
        <span className="text-muted-foreground">
          {shareTypeOf(d.mediaType).label ?? t('patient.tests.fileType')} · {fileSize(d.sizeBytes)}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={opening !== null}
          aria-busy={opening === d.id}
          aria-label={t(shown ? 'portal.documents.viewFor' : 'portal.documents.downloadFor', {
            title: d.title,
          })}
          onClick={onView}
        >
          {shown ? <FileText aria-hidden /> : <Download aria-hidden />}
          {t(shown ? 'portal.documents.view' : 'portal.documents.download')}
        </Button>
      </div>
      {/* Always present, so screen readers announce what goes in it. */}
      <div aria-live="polite" className="empty:hidden pt-2" data-testid="document-notice">
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
