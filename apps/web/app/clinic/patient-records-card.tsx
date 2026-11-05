'use client';
import { PatientRecord, PatientRecordList } from '@dhc/contracts';
import { Button, Surface } from '@dhc/ui-web';
import { useCallback, useEffect, useState } from 'react';
import { openStaffFile } from './documents-card';
import { useSession } from './session-provider';
export function PatientRecordsCard({
  patientId,
  appointmentId,
}: {
  patientId: string;
  appointmentId?: string;
}) {
  const { api, t } = useSession();
  const [rows, setRows] = useState<PatientRecord[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const data = await api.request('GET', `/patients/${patientId}/records`, {
        schema: PatientRecordList,
      });
      setRows(data.data);
      setCursor(data.nextCursor);
      setError(null);
    } catch {
      setError(t('patientRecords.loadFailed'));
    }
  }, [api, patientId, t]);
  useEffect(() => {
    void load();
  }, [load]);
  async function more() {
    setBusy(true);
    try {
      const data = await api.request('GET', `/patients/${patientId}/records`, {
        schema: PatientRecordList,
        query: { cursor: cursor ?? undefined },
      });
      setRows((old) => [...old, ...data.data]);
      setCursor(data.nextCursor);
    } catch {
      setError(t('patientRecords.loadFailed'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Surface className="space-y-4 p-5">
      <h2 className="font-display text-lg font-bold">{t('patientRecords.doctorTitle')}</h2>
      <p className="text-sm text-muted-foreground">{t('patientRecords.doctorHelp')}</p>
      {error && <p role="alert">{error}</p>}
      <Button variant="outline" disabled={busy} onClick={() => void load()}>
        {t('patientRecords.refresh')}
      </Button>
      {!rows.length && <p>{t('patientRecords.noneShared')}</p>}
      {rows.map((r) => (
        <DoctorRecord
          key={r.id + ':' + r.revision}
          record={r}
          appointmentId={appointmentId}
          changed={() => void load()}
        />
      ))}
      {cursor && (
        <Button disabled={busy} onClick={() => void more()}>
          {t('documents.more')}
        </Button>
      )}
    </Surface>
  );
}
export function DoctorRecord({
  record: r,
  appointmentId,
  changed,
}: {
  record: PatientRecord;
  appointmentId?: string;
  changed: () => void;
}) {
  const { api, t } = useSession();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [confirm, setConfirm] = useState(false);
  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      changed();
    } catch {
      setError(t('patientRecords.actionFailed'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="space-y-3 rounded-xl border p-4" data-testid="doctor-patient-record">
      <h3 className="font-semibold">{r.title}</h3>
      <p>
        {r.patient.name} · {t(`patientRecords.category.${r.category}`)}
      </p>
      {r.note && <p className="whitespace-pre-line text-sm">{r.note}</p>}
      {r.reviewedAt && (
        <p>
          {t('patientRecords.reviewed', { name: r.reviewedByName ?? t('patientRecords.doctor') })}
        </p>
      )}
      {r.usedAt && <p className="text-sm">{t('patientRecords.retained')}</p>}
      {error && <p role="alert">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={busy}
          onClick={() =>
            void run(() =>
              openStaffFile(() =>
                api.requestFile('GET', `/patient-records/${r.id}/file`, {
                  accept: r.mediaType ?? 'application/pdf',
                }),
              ),
            )
          }
        >
          {t('portal.documents.view')}
        </Button>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() =>
            void run(() =>
              api.request('POST', `/patient-records/${r.id}/review`, {
                schema: PatientRecord,
                body: { revision: r.revision },
              }),
            )
          }
        >
          {t('patientRecords.markReviewed')}
        </Button>
        {appointmentId && (
          <Button disabled={busy} onClick={() => setConfirm(!confirm)}>
            {t('patientRecords.use')}
          </Button>
        )}
      </div>
      {confirm && appointmentId && (
        <div className="space-y-2">
          <p className="text-sm">{t('patientRecords.confirmUse')}</p>
          <Button
            disabled={busy}
            onClick={() =>
              void run(() =>
                api.request('POST', `/patient-records/${r.id}/use`, {
                  schema: PatientRecord,
                  body: { revision: r.revision, appointmentId },
                }),
              )
            }
          >
            {t('patientRecords.confirm')}
          </Button>
        </div>
      )}
    </section>
  );
}
