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
import { Button, cn, Input, Label, NativeSelect, PageHeader, Surface } from '@dhc/ui-web';
import { ArrowLeft, Search } from 'lucide-react';
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
    <section aria-labelledby="book-title" className="mx-auto max-w-3xl space-y-5">
      <PageHeader
        title={<span id="book-title">{current ? t('book.rescheduleTitle') : t('book.title')}</span>}
        sub={
          <Link
            href="/clinic/queue"
            className="inline-flex items-center gap-1 underline-offset-4 hover:text-foreground hover:underline"
          >
            <ArrowLeft className="size-4" aria-hidden />
            {t('queue.title')}
          </Link>
        }
      />
      {current && (
        <p
          className="rounded-xl bg-info-soft p-4 text-sm font-medium text-info"
          data-testid="current-booking"
        >
          {t('book.current', {
            when: t('appointments.at', { date: current.date, time: current.startTime }),
          })}
        </p>
      )}

      <Surface className="space-y-4 p-5 sm:p-6">
        <h2 className="font-display text-lg font-bold">{t('book.patient')}</h2>
        {patient ? (
          <p
            className="flex flex-wrap items-center gap-x-2 gap-y-2 rounded-xl bg-accent/50 p-3 text-sm"
            data-testid="booking-patient"
          >
            <strong className="font-display text-base font-bold">{patient.name}</strong> ·{' '}
            <span className="tabular">{patient.uhid}</span> · <AgeGender patient={patient} />{' '}
            {!current && (
              <Button
                type="button"
                variant="outline"
                className="ml-auto"
                onClick={() => setPatient(null)}
              >
                {t('book.change')}
              </Button>
            )}
          </p>
        ) : (
          <PatientFinder onPick={setPatient} />
        )}
      </Surface>

      {patient && (
        <form
          className="surface space-y-6 p-5 sm:p-6"
          onSubmit={(e) => {
            e.preventDefault();
            void book(false, reasonOf(e.currentTarget));
          }}
          noValidate
        >
          <div className="grid gap-4 sm:grid-cols-3">
            {doctors.length > 0 && (
              <div className="space-y-2">
                <Label htmlFor="book-doctor">{t('availability.doctor')}</Label>
                <NativeSelect
                  id="book-doctor"
                  value={doctorId}
                  onChange={(e) => setDoctorId(e.target.value)}
                >
                  {doctors.map((d) => (
                    <option key={d.userId} value={d.userId}>
                      {d.displayName ?? d.userId}
                    </option>
                  ))}
                </NativeSelect>
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="book-clinic">{t('availability.clinic')}</Label>
              <NativeSelect
                id="book-clinic"
                value={clinicId}
                onChange={(e) => setClinicId(e.target.value)}
              >
                {clinics.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="space-y-2">
              <Label htmlFor="book-type">{t('availability.type')}</Label>
              <NativeSelect
                id="book-type"
                value={typeId}
                onChange={(e) => setTypeId(e.target.value)}
              >
                {types.map((ty) => (
                  <option key={ty.id} value={ty.id}>
                    {ty.name}
                  </option>
                ))}
              </NativeSelect>
            </div>
          </div>

          {!current && (
            <div className="flex flex-col gap-3 rounded-xl border border-dashed border-border p-4 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-muted-foreground">{t('book.walkInHelp')}</p>
              <Button
                type="button"
                variant={walkInFirst ? 'default' : 'outline'}
                className="shrink-0"
                disabled={busy || !doctorId || !clinicId || !typeId}
                onClick={(e) => void book(true, reasonOf(e.currentTarget.form))}
              >
                {t('book.addWalkIn')}
              </Button>
            </div>
          )}

          <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
            <div className="w-full space-y-2 sm:w-56">
              <Label htmlFor="book-date">{t('book.date')}</Label>
              <Input
                id="book-date"
                type="date"
                min={today}
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </div>
            <label className="flex min-h-11 cursor-pointer items-center gap-2.5 text-sm font-medium">
              <input
                type="checkbox"
                className="size-4 accent-primary"
                checked={overbook}
                onChange={(e) => {
                  setOverbook(e.target.checked);
                  if (!e.target.checked && slot?.unavailableReason === 'busy') setSlot(null);
                }}
              />{' '}
              {t('book.overbook')}
            </label>
          </div>

          <fieldset className="min-w-0">
            <legend className="mb-3 text-sm font-semibold">{t('book.slots')}</legend>
            {day?.closed && (
              <p className="rounded-xl bg-muted p-4 text-center text-sm text-muted-foreground">
                {t(`closed.${day.closed}`)}
              </p>
            )}
            {day && day.slots.length > 0 && (
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6" role="group">
                {day.slots.map((s) => {
                  const chosen = slot?.start === s.start;
                  const canPick = choosable(s);
                  return (
                    <button
                      key={s.start}
                      type="button"
                      className={cn(
                        'tabular min-h-11 cursor-pointer rounded-full border px-2 py-2 text-sm font-semibold leading-tight transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 active:scale-[.98]',
                        chosen
                          ? 'border-primary bg-primary text-primary-foreground shadow-button'
                          : !canPick
                            ? 'cursor-not-allowed border-transparent bg-muted text-muted-foreground line-through'
                            : s.unavailableReason === 'busy'
                              ? 'border-warning bg-warning-soft text-warning-foreground'
                              : 'border-border/70 bg-card hover:border-primary hover:text-primary',
                      )}
                      aria-pressed={chosen}
                      disabled={!canPick}
                      data-testid={`slot-${s.startTime}`}
                      onClick={() => setSlot(s)}
                    >
                      {s.startTime}
                      {s.unavailableReason === 'busy' && (
                        <span className="inline-block w-full text-[10px] font-medium">
                          {' '}
                          · {t('book.taken')}
                        </span>
                      )}
                      {s.unavailableReason && s.unavailableReason !== 'busy' && (
                        <span className="sr-only"> ({t(`slot.${s.unavailableReason}`)})</span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </fieldset>

          {!current && (
            <div className="space-y-2">
              <Label htmlFor="book-reason">{t('book.reason')}</Label>
              <Input id="book-reason" name="reason" maxLength={300} />
            </div>
          )}

          {error && (
            <p
              role="alert"
              className="rounded-xl bg-danger-soft p-4 text-sm font-medium text-destructive"
            >
              {error}
            </p>
          )}
          <Button type="submit" size="lg" className="w-full sm:w-auto" disabled={busy || !slot}>
            {slot
              ? t(current ? 'book.move' : 'book.confirm', { time: slot.startTime })
              : t('book.pickSlot')}
          </Button>
        </form>
      )}
      {!patient && error && (
        <p
          role="alert"
          className="rounded-xl bg-danger-soft p-4 text-sm font-medium text-destructive"
        >
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
      <form className="flex gap-2" role="search" onSubmit={search}>
        <label htmlFor="find-patient" className="sr-only">
          {t('book.findPatient')}
        </label>
        <div className="relative min-w-0 flex-1">
          <Search
            className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            id="find-patient"
            type="search"
            className="pl-10"
            value={q}
            placeholder={t('book.findPatient')}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <Button type="submit">{t('common.search')}</Button>
      </form>
      {results && results.length === 0 && (
        <p className="rounded-xl bg-muted p-4 text-sm text-muted-foreground">
          {t('dashboard.noPatients')}
        </p>
      )}
      {results && results.length > 0 && (
        <ul className="divide-y divide-border/60 rounded-xl border border-border/60">
          {results.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-x-2 gap-y-2 p-3 text-sm">
              <span className="min-w-0 flex-1">
                <span className="font-semibold">{p.name}</span> · {p.uhid} ·{' '}
                <AgeGender patient={p} />
              </span>{' '}
              <Button type="button" variant="outline" onClick={() => onPick(p)}>
                {t('book.choose')}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
