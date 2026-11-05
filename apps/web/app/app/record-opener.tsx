'use client';
import type { RecordLinkTarget } from '@dhc/contracts';
import { Button } from '@dhc/ui-web';
import { useRef, useState } from 'react';
import { openFile } from '../../lib/patient-files';
import { portalErrorMessage } from '../../lib/patient';
import { BlockedDownload, Notice } from './parts';
import { usePatientSession } from './session-provider';

export function RecordOpener({ target }: { target: RecordLinkTarget }) {
  const { api, files, t } = usePatientSession();
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<{ url: string; name: string } | null>(null);
  async function open() {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    setBlocked(null);
    try {
      const fetchFile = () =>
        target.kind === 'document_ready'
          ? api.portalDocumentFile(target.sourceId)
          : target.kind === 'prescription_ready'
            ? api.portalPrescriptionPdf(target.sourceId)
            : api.portalReferralLetterPdf(target.sourceId);
      const ext = target.mediaType === 'application/pdf' ? 'pdf' : target.mediaType.split('/')[1]!;
      const outcome = await openFile(
        fetchFile,
        { name: `record.${ext}`, mediaType: target.mediaType },
        files,
      );
      if (outcome.kind === 'blocked') setBlocked(outcome);
    } catch (e) {
      setError(portalErrorMessage(e, t));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="space-y-3">
      <Button disabled={busy} onClick={() => void open()}>
        {t('portal.record.open')}
      </Button>
      {error && <Notice tone="error">{error}</Notice>}
      {blocked && <BlockedDownload {...blocked} />}
    </div>
  );
}
