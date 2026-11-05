'use client';
import { PatientRecord } from '@dhc/contracts';
import { Button } from '@dhc/ui-web';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useSession } from '../session-provider';
import { DoctorRecord } from '../patient-records-card';
export default function SharedRecordPage() {
  const { api, status, me, t } = useSession();
  const [token, setToken] = useState(''),
    [record, setRecord] = useState<PatientRecord | null>(null),
    [error, setError] = useState(false);
  useEffect(() => {
    setToken(window.location.hash.slice(1));
  }, []);
  const load = useCallback(() => {
    if (!token || status !== 'signedIn' || me?.role !== 'doctor') return;
    api
      .request('POST', '/record-shares/resolve', { schema: PatientRecord, body: { token } })
      .then((r) => {
        setRecord(r);
        setError(false);
        window.history.replaceState(null, '', window.location.pathname);
      })
      .catch(() => setError(true));
  }, [api, status, me?.role, token]);
  useEffect(load, [load]);
  return (
    <main className="mx-auto max-w-2xl space-y-5 p-6">
      <h1 className="font-display text-2xl font-bold">{t('patientRecords.doctorTitle')}</h1>
      {status === 'loading' ? (
        <p>{t('common.loading')}</p>
      ) : status !== 'signedIn' || me?.role !== 'doctor' ? (
        <>
          <p>{t('patientRecords.signInHelp')}</p>
          <Button asChild>
            <Link href="/clinic/login" target="_blank" rel="noopener noreferrer">
              {t('patientRecords.signIn')}
            </Link>
          </Button>
          <Button variant="outline" onClick={() => window.location.reload()}>
            {t('patientRecords.afterSignIn')}
          </Button>
        </>
      ) : record ? (
        <>
          <DoctorRecord record={record} changed={load} />
          <Link className="underline" href={`/clinic/patients/${record.patient.id}`}>
            {t('patientRecords.openPatient')}
          </Link>
        </>
      ) : (
        <>
          <p>{t(error ? 'patientRecords.unavailable' : 'common.loading')}</p>
          <Button variant="outline" onClick={load}>
            {t('patientRecords.refresh')}
          </Button>
        </>
      )}
    </main>
  );
}
