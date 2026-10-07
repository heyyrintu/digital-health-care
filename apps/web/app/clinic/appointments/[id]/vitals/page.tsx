'use client';

import { ApiError } from '@dhc/api-client';
import { AppointmentDetail, VitalsResponse, type Vitals } from '@dhc/contracts';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { AgeGender } from '../../../patient-bits';
import { useSession } from '../../../session-provider';
import { ClinicShell } from '../../../shell';
import { VitalsForm } from '../../../vitals-form';

/** Front desk records a visit's vitals before the patient goes in (PRD §3.2, §6.1). */
export default function VitalsPage() {
  return <ClinicShell>{() => <VitalsScreen />}</ClinicShell>;
}

function VitalsScreen() {
  const { id } = useParams<{ id: string }>();
  const { api, signOut, t } = useSession();
  const [appointment, setAppointment] = useState<AppointmentDetail | null>(null);
  const [vitals, setVitals] = useState<Vitals | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fail = (e: unknown) => {
      if (e instanceof ApiError && e.status === 401) return void signOut('expired');
      setError(e instanceof ApiError ? e.message : t('error.network'));
    };
    const path = `/appointments/${encodeURIComponent(id)}`;
    api.request('GET', path, { schema: AppointmentDetail }).then(setAppointment).catch(fail);
    api
      .request('GET', `${path}/vitals`, { schema: VitalsResponse })
      .then((r) => setVitals(r.vitals))
      .catch(fail);
  }, [api, id, signOut, t]);

  return (
    <section className="card">
      <p>
        <Link href={`/clinic/queue${appointment ? `?date=${appointment.date}` : ''}`}>
          {t('consult.back')}
        </Link>
      </p>
      {error && (
        <p role="alert" className="alert">
          {error}
        </p>
      )}
      {appointment && vitals !== undefined ? (
        <>
          <h1>{t('vitals.pageTitle', { name: appointment.patient.name })}</h1>
          <p className="patient-meta">
            {appointment.patient.uhid} · <AgeGender patient={appointment.patient} /> ·{' '}
            {t('queue.token', { token: appointment.tokenNumber })}
          </p>
          <VitalsForm
            appointmentId={appointment.id}
            vitals={vitals}
            patient={appointment.patient}
            editable={!['cancelled', 'no_show', 'rescheduled'].includes(appointment.status)}
          />
        </>
      ) : (
        !error && <p aria-live="polite">{t('common.loading')}</p>
      )}
    </section>
  );
}
