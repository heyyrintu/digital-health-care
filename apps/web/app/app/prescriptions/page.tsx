'use client';

import type { PortalPrescription, PortalPrescriptionList } from '@dhc/contracts';
import { istDateKey, prescriptionPdfName, shortDate } from '@dhc/domain';
import { Button, EmptyState } from '@dhc/ui-web';
import { Download, FileText } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { portalErrorMessage } from '../../../lib/patient';
import { openFile, saveFile } from '../../../lib/patient-files';
import { BlockedDownload, LoadError, Loading, Notice, PortalPage } from '../parts';
import { usePatientSession } from '../session-provider';
import { PortalShell } from '../shell';

/** PRD §4.4: every signed version; revised and cancelled ones are labelled and still open. */
export default function PrescriptionsPage() {
  return <PortalShell>{() => <Prescriptions />}</PortalShell>;
}

type Load =
  | { status: 'loading' }
  | { status: 'error'; error: unknown }
  | { status: 'ready'; data: PortalPrescriptionList };

function Prescriptions() {
  const { api, files, locale, t } = usePatientSession();
  const [list, setList] = useState<Load>({ status: 'loading' });
  /** The one PDF being downloaded; the other buttons wait for it. */
  const [opening, setOpening] = useState<string | null>(null);
  /** Set synchronously, so a double click (before React re-renders) fetches once. */
  const busy = useRef(false);
  const [notice, setNotice] = useState<
    | { id: string; tone: 'success' | 'error'; text: string }
    /** The browser blocked the new tab: a link to download the PDF instead. */
    | { id: string; tone: 'blocked'; url: string; name: string }
    | null
  >(null);

  // The API returns the whole list (no pages): a family's prescriptions are few.
  const load = useCallback(async () => {
    setList({ status: 'loading' });
    try {
      setList({ status: 'ready', data: await api.portalPrescriptions() });
    } catch (error) {
      setList({ status: 'error', error });
    }
  }, [api]);
  useEffect(() => void load(), [load]);

  async function open(rx: PortalPrescription, how: 'open' | 'save') {
    if (busy.current) return;
    busy.current = true;
    setOpening(rx.id);
    setNotice(null);
    const name = prescriptionPdfName(rx.number, rx.version);
    const fetchPdf = () => api.portalPrescriptionPdf(rx.id);
    try {
      if (how === 'save') {
        // The person's own Download: saved straight away.
        await saveFile(fetchPdf, name, files);
      } else {
        const outcome = await openFile(fetchPdf, { name, mediaType: 'application/pdf' }, files);
        if (outcome.kind === 'blocked') setNotice({ id: rx.id, tone: 'blocked', ...outcome });
        // The server sent something other than a PDF: it was saved, never shown.
        if (outcome.kind === 'saved') {
          setNotice({ id: rx.id, tone: 'success', text: t('portal.files.saved') });
        }
      }
    } catch (e) {
      setNotice({ id: rx.id, tone: 'error', text: portalErrorMessage(e, t) });
    } finally {
      busy.current = false;
      setOpening(null);
    }
  }

  return (
    <PortalPage title={t('patient.nav.prescriptions')}>
      {list.status === 'loading' && <Loading />}
      {list.status === 'error' && <LoadError error={list.error} retry={() => void load()} />}
      {list.status === 'ready' &&
        (list.data.data.length === 0 ? (
          <EmptyState title={t('patient.rx.none')} />
        ) : (
          <ul className="space-y-3" data-testid="prescriptions">
            {list.data.data.map((rx) => (
              <li key={rx.id} className="surface space-y-1 p-4 text-sm" data-testid="prescription">
                <p className="font-display text-base font-bold">{rx.patient.name}</p>
                <p className="font-medium">
                  {rx.number} · {t('patient.rx.version', { version: rx.version })}
                </p>
                <p className="text-muted-foreground">
                  {rx.doctorName ? `${rx.doctorName} · ` : ''}
                  {shortDate(rx.date, locale)}
                </p>
                {rx.signedAt && (
                  <p className="text-xs text-muted-foreground" data-testid="prescription-signed">
                    {t('patient.rx.signed', {
                      // The IST day it was signed: an amendment can come days after the visit.
                      date: shortDate(istDateKey(rx.signedAt), locale),
                    })}
                  </p>
                )}
                {rx.status === 'superseded' && (
                  <p className="text-xs font-medium text-muted-foreground">
                    {t('patient.rx.superseded')}
                  </p>
                )}
                {rx.status === 'void' && (
                  <p className="text-xs font-medium text-destructive">{t('patient.rx.void')}</p>
                )}
                {rx.signedAt && (
                  <div className="flex flex-wrap gap-2 pt-2">
                    <Button
                      type="button"
                      variant="outline"
                      disabled={opening !== null}
                      aria-busy={opening === rx.id}
                      onClick={() => void open(rx, 'open')}
                    >
                      <FileText aria-hidden />
                      {opening === rx.id ? t('common.loading') : t('portal.rx.open')}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={opening !== null}
                      onClick={() => void open(rx, 'save')}
                    >
                      <Download aria-hidden />
                      {t('portal.rx.download')}
                    </Button>
                  </div>
                )}
                {/* Always present, so screen readers announce what goes in it. */}
                <div aria-live="polite" className="empty:hidden pt-2">
                  {notice?.id === rx.id &&
                    (notice.tone === 'blocked' ? (
                      <BlockedDownload url={notice.url} name={notice.name} />
                    ) : (
                      <Notice tone={notice.tone}>{notice.text}</Notice>
                    ))}
                </div>
              </li>
            ))}
          </ul>
        ))}
    </PortalPage>
  );
}
