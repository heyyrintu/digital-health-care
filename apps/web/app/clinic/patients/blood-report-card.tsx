'use client';
import { DoctorBloodReport, ProfileConfirmed } from '@dhc/contracts';
import { Button, Surface } from '@dhc/ui-web';
import { useCallback, useEffect, useState } from 'react';
import { useSession } from '../session-provider';
export function BloodReportCard({
  patientId,
  onConfirmed,
}: {
  patientId: string;
  onConfirmed: () => void;
}) {
  const { api, t } = useSession();
  const [report, setReport] = useState<DoctorBloodReport | null>(null),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    setError(null);
    api
      .request('GET', `/patients/${patientId}/reported-blood-group`, { schema: DoctorBloodReport })
      .then(setReport)
      .catch(() => setError(t('patientProfile.loadReportFailed')));
  }, [api, patientId, t]);
  useEffect(load, [load]);
  async function confirm() {
    if (!report) return;
    setBusy(true);
    setError(null);
    try {
      await api.request('POST', `/patients/${patientId}/reported-blood-group/confirm`, {
        schema: ProfileConfirmed,
        body: { updatedAt: report.updatedAt },
      });
      load();
      onConfirmed();
    } catch {
      setError(t('patientProfile.confirmFailed'));
    } finally {
      setBusy(false);
    }
  }
  if (!report?.pending && !error) return null;
  return (
    <Surface className="space-y-3 p-5">
      <h2 className="font-display text-lg font-bold">{t('patientProfile.reportedBlood')}</h2>
      {report?.pending && (
        <>
          <p>
            {report.group} · {t('patientProfile.pending')}
          </p>
          <Button disabled={busy} onClick={() => void confirm()}>
            {t('patientProfile.confirmReport')}
          </Button>
        </>
      )}
      {error && (
        <>
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
          <Button variant="link" onClick={load}>
            {t('patientProfile.reload')}
          </Button>
        </>
      )}
    </Surface>
  );
}
