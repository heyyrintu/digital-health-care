'use client';

import { ApiError } from '@dhc/api-client';
import { AppointmentDetail, VitalsResponse, type Vitals } from '@dhc/contracts';
import { PageHeader, Surface } from '@dhc/ui-web';
import { ArrowLeft } from 'lucide-react';
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
    <section className="mx-auto max-w-3xl space-y-5">
      <p>
        <Link
          href={`/clinic/queue${appointment ? `?date=${appointment.date}` : ''}`}
          className="inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          <ArrowLeft className="size-4" aria-hidden />
          {t('consult.back')}
        </Link>
      </p>
      {error && (
        <p
          role="alert"
          className="rounded-xl bg-danger-soft p-4 text-sm font-medium text-destructive"
        >
          {error}
        </p>
      )}
      {appointment && vitals !== undefined ? (
        <>
          <PageHeader
            title={t('vitals.pageTitle', { name: appointment.patient.name })}
            sub={
              <>
                <span className="tabular">{appointment.patient.uhid}</span> ·{' '}
                <AgeGender patient={appointment.patient} /> ·{' '}
                <span className="font-semibold text-foreground">
                  {t('queue.token', { token: appointment.tokenNumber })}
                </span>
              </>
            }
          />
          <Surface className="p-5 sm:p-6">
            <VitalsForm
              appointmentId={appointment.id}
              vitals={vitals}
              patient={appointment.patient}
              editable={!['cancelled', 'no_show', 'rescheduled'].includes(appointment.status)}
            />
          </Surface>
        </>
      ) : (
        !error && (
          <p aria-live="polite" className="text-sm text-muted-foreground">
            {t('common.loading')}
          </p>
        )
      )}
    </section>
  );
}
