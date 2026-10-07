'use client';

import { ApiError } from '@dhc/api-client';
import {
  AppointmentDetail,
  ClinicList,
  ConsultationTypeList,
  DoctorList,
  PatientDetail,
  PatientListResponse,
  SlotsResponse,
  type Clinic,
  type ConsultationType,
  type Doctor,
  type MeResponse,
  type PatientSummary,
  type Slot,
} from '@dhc/contracts';
import { istDateKey } from '@dhc/domain';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState, type FormEvent } from 'react';
import { AgeGender } from '../../patient-bits';
import { useSession } from '../../session-provider';
import { ClinicShell, canRegister } from '../../shell';

/**
 * Book a patient into a slot, add a walk-in, or reschedule (`?reschedule=<id>`).
 * Patients come from the register (`?patientId=` skips the search).
 */
export default function BookPage() {
  return (
    <ClinicShell>
      {(me) =>
        canRegister(me.role) ? (
          <Suspense>
            <Book me={me} />
          </Suspense>
        ) : null
      }
    </ClinicShell>
  );
}

type Who = Pick<PatientSummary, 'id' | 'name' | 'uhid' | 'dob' | 'gender'>;

function Book({ me }: { me: MeResponse }) {
  const { api, signOut, t } = useSession();
  const router = useRouter();
  const params = useSearchParams();
  const rescheduleId = params.get('reschedule');
  const walkInFirst = params.get('walkIn') === '1';
  const today = istDateKey(new Date());

  const [patient, setPatient] = useState<Who | null>(null);
  const [current, setCurrent] = useState<AppointmentDetail | null>(null);
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [clinics, setClinics] = useState<Clinic[]>([]);
  const [types, setTypes] = useState<ConsultationType[]>([]);
  const [doctorId, setDoctorId] = useState('');
  const [clinicId, setClinicId] = useState('');
  const [typeId, setTypeId] = useState('');
  const [date, setDate] = useState(params.get('date') ?? today);
  const [overbook, setOverbook] = useState(false);
  const [day, setDay] = useState<SlotsResponse | null>(null);
  const [slot, setSlot] = useState<Slot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handle = useCallback(
    (e: unknown) => {
      if (e instanceof ApiError && e.status === 401) return void signOut('expired');
      setError(e instanceof ApiError ? e.message : t('error.network'));
    },
    [signOut, t],
  );

  // Pickers, then whatever the URL already decided (patient, or the booking to move).
  useEffect(() => {
    const patientId = params.get('patientId');
    Promise.all([
      api.request('GET', '/doctors', { schema: DoctorList }),
      api.request('GET', '/clinics', { schema: ClinicList }),
      api.request('GET', '/consultation-types', { schema: ConsultationTypeList }),
      rescheduleId
        ? api.request('GET', `/appointments/${encodeURIComponent(rescheduleId)}`, {
            schema: AppointmentDetail,
          })
        : Promise.resolve(null),
      patientId && !rescheduleId
        ? api.request('GET', `/patients/${encodeURIComponent(patientId)}`, {
            schema: PatientDetail,
          })
        : Promise.resolve(null),
    ])
      .then(([d, c, ty, appt, p]) => {
        const activeClinics = c.data.filter((x) => x.active);
        const activeTypes = ty.data.filter((x) => x.active);
        setDoctors(d.data);
        setClinics(activeClinics);
        setTypes(activeTypes);
        if (appt) {
          setCurrent(appt);
          setPatient(appt.patient);
          setDoctorId(appt.doctorUserId);
          setClinicId(appt.clinicId);
          setTypeId(appt.consultationTypeId);
          setDate(appt.date < today ? today : appt.date);
        } else {
          setDoctorId(me.role === 'doctor' ? me.user.id : (d.data[0]?.userId ?? ''));
          setClinicId(activeClinics[0]?.id ?? '');
          setTypeId(activeTypes[0]?.id ?? '');
          if (p) setPatient(p);
        }
      })
      .catch(handle);
    // Load once for the page's URL.
  }, [api, handle, me, params, rescheduleId, today]);

  useEffect(() => {
    if (!doctorId || !clinicId || !typeId || !date) return;
    let cancelled = false;
    setDay(null);
    setSlot(null);
    api
      .request('GET', '/slots', {
        schema: SlotsResponse,
        query: { doctorId, clinicId, consultationTypeId: typeId, date, channel: 'staff' },
      })
      .then((result) => !cancelled && setDay(result))
      .catch((e: unknown) => !cancelled && handle(e));
    return () => {
      cancelled = true;
    };
  }, [api, handle, doctorId, clinicId, typeId, date]);

  const choosable = (s: Slot) => s.available || (overbook && s.unavailableReason === 'busy');

  const reasonOf = (form: HTMLFormElement | null) =>
    form ? String(new FormData(form).get('reason') ?? '').trim() : '';

  async function book(walkIn: boolean, reason: string) {
    if (!patient) return;
    if (!walkIn && !slot) return setError(t('book.pickSlot'));
    setBusy(true);
    setError(null);
    try {
      const booked = current
        ? await api.request('POST', `/appointments/${current.id}/reschedule`, {
            schema: AppointmentDetail,
            body: {
              startAt: slot!.start,
              doctorUserId: doctorId,
              clinicId,
              consultationTypeId: typeId,
              overbook: slot!.unavailableReason === 'busy',
            },
          })
        : await api.request('POST', '/appointments', {
            schema: AppointmentDetail,
            body: {
              patientId: patient.id,
              doctorUserId: doctorId,
              clinicId,
              consultationTypeId: typeId,
              ...(walkIn
                ? { walkIn: true }
                : { startAt: slot!.start, overbook: slot!.unavailableReason === 'busy' }),
              reason: reason || null,
            },
          });
      router.push(
        `/clinic/queue?date=${booked.date}&tab=${booked.status === 'checked_in' ? 'myOpd' : 'booked'}`,
      );
    } catch (e) {
      handle(e);
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="book-title" className="card">
      <h1 id="book-title">{current ? t('book.rescheduleTitle') : t('book.title')}</h1>
      <p>
        <Link href="/clinic/queue">{t('queue.title')}</Link>
      </p>
      {current && (
        <p className="hint" data-testid="current-booking">
          {t('book.current', {
            when: t('appointments.at', { date: current.date, time: current.startTime }),
          })}
        </p>
      )}

      <h2>{t('book.patient')}</h2>
      {patient ? (
        <p data-testid="booking-patient">
          <strong>{patient.name}</strong> · {patient.uhid} · <AgeGender patient={patient} />{' '}
          {!current && (
            <button type="button" className="secondary" onClick={() => setPatient(null)}>
              {t('book.change')}
            </button>
          )}
        </p>
      ) : (
        <PatientFinder onPick={setPatient} />
      )}

      {patient && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void book(false, reasonOf(e.currentTarget));
          }}
          noValidate
        >
          <div className="pickers">
            {doctors.length > 0 && (
              <div>
                <label htmlFor="book-doctor">{t('availability.doctor')}</label>
                <select
                  id="book-doctor"
                  value={doctorId}
                  onChange={(e) => setDoctorId(e.target.value)}
                >
                  {doctors.map((d) => (
                    <option key={d.userId} value={d.userId}>
                      {d.displayName ?? d.userId}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div>
              <label htmlFor="book-clinic">{t('availability.clinic')}</label>
              <select
                id="book-clinic"
                value={clinicId}
                onChange={(e) => setClinicId(e.target.value)}
              >
                {clinics.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="book-type">{t('availability.type')}</label>
              <select id="book-type" value={typeId} onChange={(e) => setTypeId(e.target.value)}>
                {types.map((ty) => (
                  <option key={ty.id} value={ty.id}>
                    {ty.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {!current && (
            <div className="walk-in">
              <p className="hint">{t('book.walkInHelp')}</p>
              <button
                type="button"
                className={walkInFirst ? 'primary' : 'secondary'}
                disabled={busy || !doctorId || !clinicId || !typeId}
                onClick={(e) => void book(true, reasonOf(e.currentTarget.form))}
              >
                {t('book.addWalkIn')}
              </button>
            </div>
          )}

          <div className="inline-form">
            <div>
              <label htmlFor="book-date">{t('book.date')}</label>
              <input
                id="book-date"
                type="date"
                min={today}
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </div>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={overbook}
                onChange={(e) => {
                  setOverbook(e.target.checked);
                  if (!e.target.checked && slot?.unavailableReason === 'busy') setSlot(null);
                }}
              />{' '}
              {t('book.overbook')}
            </label>
          </div>

          <fieldset className="slot-picker">
            <legend>{t('book.slots')}</legend>
            {day?.closed && <p>{t(`closed.${day.closed}`)}</p>}
            {day && day.slots.length > 0 && (
              <div className="slot-grid" role="group">
                {day.slots.map((s) => (
                  <button
                    key={s.start}
                    type="button"
                    className={slot?.start === s.start ? 'slot selected' : 'slot'}
                    aria-pressed={slot?.start === s.start}
                    disabled={!choosable(s)}
                    data-testid={`slot-${s.startTime}`}
                    onClick={() => setSlot(s)}
                  >
                    {s.startTime}
                    {s.unavailableReason === 'busy' && (
                      <span className="slot-note"> · {t('book.taken')}</span>
                    )}
                    {s.unavailableReason && s.unavailableReason !== 'busy' && (
                      <span className="visually-hidden"> ({t(`slot.${s.unavailableReason}`)})</span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </fieldset>

          {!current && (
            <div className="inline-form">
              <div>
                <label htmlFor="book-reason">{t('book.reason')}</label>
                <input id="book-reason" name="reason" maxLength={300} />
              </div>
            </div>
          )}

          {error && (
            <p role="alert" className="alert">
              {error}
            </p>
          )}
          <button type="submit" className="primary" disabled={busy || !slot}>
            {slot
              ? t(current ? 'book.move' : 'book.confirm', { time: slot.startTime })
              : t('book.pickSlot')}
          </button>
        </form>
      )}
      {!patient && error && (
        <p role="alert" className="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function PatientFinder({ onPick }: { onPick(p: Who): void }) {
  const { api, t } = useSession();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<PatientSummary[] | null>(null);

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!q.trim()) return;
    api
      .request('GET', '/patients', {
        schema: PatientListResponse,
        query: { q: q.trim(), limit: 10 },
      })
      .then((r) => setResults(r.data))
      .catch(() => setResults([]));
  }

  return (
    <>
      <form className="search" role="search" onSubmit={search}>
        <label htmlFor="find-patient" className="visually-hidden">
          {t('book.findPatient')}
        </label>
        <input
          id="find-patient"
          type="search"
          value={q}
          placeholder={t('book.findPatient')}
          onChange={(e) => setQ(e.target.value)}
        />
        <button type="submit">{t('common.search')}</button>
      </form>
      {results && results.length === 0 && <p>{t('dashboard.noPatients')}</p>}
      {results && results.length > 0 && (
        <ul className="pick-list">
          {results.map((p) => (
            <li key={p.id}>
              {p.name} · {p.uhid} · <AgeGender patient={p} />{' '}
              <button type="button" className="secondary" onClick={() => onPick(p)}>
                {t('book.choose')}
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
