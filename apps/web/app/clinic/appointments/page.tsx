'use client';

import { ApiError } from '@dhc/api-client';
import {
  AppointmentDetail,
  AppointmentList,
  DoctorList,
  type Appointment,
  type AppointmentAction,
  type Doctor,
  type MeResponse,
} from '@dhc/contracts';
import { istDateKey } from '@dhc/domain';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState, type FormEvent } from 'react';
import { AgeGender, TagChip } from '../patient-bits';
import { useSession } from '../session-provider';
import { ClinicShell, canRegister } from '../shell';
import { actionsFor, canReschedule } from './rules';

/** A day's appointments and walk-ins with their status actions (PRD §5). */
export default function AppointmentsPage() {
  return (
    <ClinicShell>
      {(me) =>
        me.role === 'patient' ? null : (
          <Suspense>
            <Appointments me={me} />
          </Suspense>
        )
      }
    </ClinicShell>
  );
}

function Appointments({ me }: { me: MeResponse }) {
  const { api, signOut, t } = useSession();
  const router = useRouter();
  const params = useSearchParams();
  const today = istDateKey(new Date());
  const date = params.get('date') ?? today;
  const [doctorId, setDoctorId] = useState('');
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [list, setList] = useState<Appointment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);

  const handle = useCallback(
    (e: unknown) => {
      if (e instanceof ApiError && e.status === 401) return void signOut('expired');
      setError(e instanceof ApiError ? e.message : t('error.network'));
    },
    [signOut, t],
  );

  const load = useCallback(async () => {
    const result = await api.request('GET', '/appointments', {
      schema: AppointmentList,
      query: { date, doctorId: doctorId || undefined },
    });
    setList(result.data);
  }, [api, date, doctorId]);

  useEffect(() => {
    setList(null);
    setError(null);
    load().catch(handle);
  }, [load, handle]);

  useEffect(() => {
    api
      .request('GET', '/doctors', { schema: DoctorList })
      .then((d) => setDoctors(d.data))
      .catch(() => undefined);
  }, [api]);

  async function act(a: Appointment, action: AppointmentAction, reason?: string) {
    setBusyId(a.id);
    setError(null);
    try {
      await api.request('POST', `/appointments/${a.id}/actions`, {
        schema: AppointmentDetail,
        body: { action, reason: reason ?? null },
      });
      setCancelling(null);
      await load();
    } catch (e) {
      handle(e);
    } finally {
      setBusyId(null);
    }
  }

  function cancel(event: FormEvent<HTMLFormElement>, a: Appointment) {
    event.preventDefault();
    const reason = String(new FormData(event.currentTarget).get('reason') ?? '').trim();
    void act(a, 'cancel', reason);
  }

  const now = new Date();
  return (
    <section aria-labelledby="appointments-title" className="card">
      <div className="card-header">
        <h1 id="appointments-title">{t('appointments.title')}</h1>
        {canRegister(me.role) && (
          <div className="header-actions">
            <Link className="button-link secondary" href="/clinic/appointments/new?walkIn=1">
              {t('appointments.walkIn')}
            </Link>
            <Link className="button-link" href={`/clinic/appointments/new?date=${date}`}>
              {t('appointments.book')}
            </Link>
          </div>
        )}
      </div>
      <p>
        <Link href="/clinic">{t('availability.back')}</Link>
      </p>
      <div className="inline-form">
        <div>
          <label htmlFor="appointments-date">{t('appointments.date')}</label>
          <input
            id="appointments-date"
            type="date"
            value={date}
            onChange={(e) =>
              e.target.value && router.replace(`/clinic/appointments?date=${e.target.value}`)
            }
          />
        </div>
        {doctors.length > 1 && (
          <div>
            <label htmlFor="appointments-doctor">{t('availability.doctor')}</label>
            <select
              id="appointments-doctor"
              value={doctorId}
              onChange={(e) => setDoctorId(e.target.value)}
            >
              <option value="">{t('appointments.allDoctors')}</option>
              {doctors.map((d) => (
                <option key={d.userId} value={d.userId}>
                  {d.displayName ?? d.userId}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
      {error && (
        <p role="alert" className="alert">
          {error}
        </p>
      )}
      {list && list.length === 0 && <p>{t('appointments.none')}</p>}
      {list && list.length > 0 && (
        <>
          <p className="hint">{t('appointments.count', { count: list.length })}</p>
          <ul className="appointment-list" data-testid="appointments">
            {list.map((a) => {
              const actions = actionsFor(a, { role: me.role, userId: me.user.id }, today, now);
              return (
                <li
                  key={a.id}
                  data-testid={`appointment-${a.patient.uhid}`}
                  className={`appt status-${a.status}`}
                >
                  <div
                    className="appt-token"
                    aria-label={`${t('appointments.token')} ${a.tokenNumber}`}
                  >
                    {a.tokenNumber}
                  </div>
                  <div className="appt-main">
                    <p>
                      <strong>{a.startTime}</strong> ·{' '}
                      <Link href={`/clinic/patients/${a.patient.id}`}>{a.patient.name}</Link> ·{' '}
                      {a.patient.uhid} · <AgeGender patient={a.patient} />
                    </p>
                    <p className="hint">
                      {a.doctorName ?? t('availability.doctor')} · {a.consultationTypeName}
                      {a.reason && ` · ${a.reason}`}
                    </p>
                    <p>
                      <span className="pill" data-testid="appointment-status">
                        {t(`status.${a.status}`)}
                      </span>
                      {a.source === 'walk_in' && (
                        <span className="pill">{t('appointments.walkInBadge')}</span>
                      )}
                      {a.overbook && (
                        <span className="pill">{t('appointments.overbookBadge')}</span>
                      )}
                      {a.patient.tags.map((tag) => (
                        <TagChip key={tag.id} tag={tag} />
                      ))}
                      {a.cancelReason && <span className="hint"> {a.cancelReason}</span>}
                    </p>
                    {cancelling === a.id && (
                      <form className="inline-form" onSubmit={(e) => cancel(e, a)}>
                        <div>
                          <label htmlFor={`reason-${a.id}`}>{t('appointments.cancelReason')}</label>
                          <input id={`reason-${a.id}`} name="reason" required maxLength={300} />
                        </div>
                        <button type="submit" disabled={busyId === a.id}>
                          {t('action.cancel')}
                        </button>
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => setCancelling(null)}
                        >
                          {t('appointments.keep')}
                        </button>
                      </form>
                    )}
                  </div>
                  <div className="appt-actions">
                    {actions
                      .filter((action) => action !== 'cancel')
                      .map((action) => (
                        <button
                          key={action}
                          type="button"
                          className={action === 'no_show' ? 'secondary' : 'primary'}
                          disabled={busyId === a.id}
                          onClick={() => void act(a, action)}
                        >
                          {t(`action.${action}`)}
                        </button>
                      ))}
                    {canReschedule(a, me.role) && (
                      <Link
                        className="button-link secondary"
                        href={`/clinic/appointments/new?reschedule=${a.id}`}
                      >
                        {t('action.reschedule')}
                      </Link>
                    )}
                    {actions.includes('cancel') && cancelling !== a.id && (
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => setCancelling(a.id)}
                      >
                        {t('action.cancel')}
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
