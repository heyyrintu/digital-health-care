'use client';

import {
  PortalAppointment,
  type BookingOptions,
  type Slot,
  type SlotsResponse,
} from '@dhc/contracts';
import { istDateKey, shortDate } from '@dhc/domain';
import { Button, DateStrip, SlotPicker, Surface } from '@dhc/ui-web';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  bookingDates,
  keepAttemptKey,
  newAttemptKey,
  portalErrorMessage,
  slotTaken,
} from '../../../../../lib/patient';
import { LoadError, Loading, Notice, PortalPage } from '../../../parts';
import { usePatientSession } from '../../../session-provider';
import { PortalShell } from '../../../shell';

type Load<T> =
  { status: 'loading' } | { status: 'error'; error: unknown } | { status: 'ready'; data: T };

export default function ReschedulePage() {
  const { id } = useParams<{ id: string }>();
  return <PortalShell>{() => <Reschedule id={id} />}</PortalShell>;
}

function Reschedule({ id }: { id: string }) {
  const { api, t } = usePatientSession();
  const [load, setLoad] = useState<
    Load<{ appointment: PortalAppointment; options: BookingOptions }>
  >({ status: 'loading' });
  const refresh = useCallback(() => {
    setLoad({ status: 'loading' });
    Promise.all([
      api.request('GET', `/portal/appointments/${id}`, { schema: PortalAppointment }),
      api.bookingOptions(),
    ])
      .then(([appointment, options]) =>
        setLoad({ status: 'ready', data: { appointment, options } }),
      )
      .catch((error: unknown) => setLoad({ status: 'error', error }));
  }, [api, id]);
  useEffect(refresh, [refresh]);
  return (
    <PortalPage title={t('patient.reschedule.title')}>
      {load.status === 'loading' && <Loading />}
      {load.status === 'error' && <LoadError error={load.error} retry={refresh} />}
      {load.status === 'ready' && <MoveForm key={id} {...load.data} />}
    </PortalPage>
  );
}

function MoveForm({
  appointment,
  options,
}: {
  appointment: PortalAppointment;
  options: BookingOptions;
}) {
  const { api, t, locale } = usePatientSession();
  const days = useMemo(() => bookingDates(istDateKey(new Date()), options), [options]);
  const [date, setDate] = useState(days[0]!);
  const [day, setDay] = useState<Load<SlotsResponse>>({ status: 'loading' });
  const [slot, setSlot] = useState<Slot | null>(null);
  const [attempt, setAttempt] = useState(newAttemptKey);
  const [busy, setBusy] = useState(false);
  // An unknown response freezes the choice until the same request has been recovered.
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [moved, setMoved] = useState<PortalAppointment | null>(null);
  const sequence = useRef(0);
  const booking = appointment.booking;
  const eligible = !!(
    appointment.canReschedule &&
    booking &&
    options.doctors.some((d) => d.userId === booking.doctorUserId) &&
    options.clinics.some((c) => c.id === booking.clinicId) &&
    options.consultationTypes.some((c) => c.id === booking.consultationTypeId)
  );
  const loadDay = useCallback(() => {
    const request = ++sequence.current;
    setSlot(null);
    setAttempt(newAttemptKey());
    setDay({ status: 'loading' });
    if (!eligible || !booking) return;
    api
      .portalSlots({
        doctorId: booking.doctorUserId,
        clinicId: booking.clinicId,
        consultationTypeId: booking.consultationTypeId,
        date,
      })
      .then((data) => {
        if (request === sequence.current) setDay({ status: 'ready', data });
      })
      .catch((error: unknown) => {
        if (request === sequence.current) setDay({ status: 'error', error });
      });
  }, [api, booking, date, eligible]);
  useEffect(() => {
    loadDay();
    return () => {
      sequence.current++;
    };
  }, [loadDay]);

  async function move() {
    if (!slot || busy) return;
    setBusy(true);
    setError(null);
    try {
      setMoved(
        await api.request('POST', `/portal/appointments/${appointment.id}/reschedule`, {
          schema: PortalAppointment,
          body: { startAt: slot.start },
          idempotencyKey: attempt,
        }),
      );
      setUncertain(false);
    } catch (e) {
      setError(portalErrorMessage(e, t));
      const unknown = keepAttemptKey(e);
      setUncertain(unknown);
      if (!unknown) setAttempt(newAttemptKey());
      if (slotTaken(e)) loadDay();
    } finally {
      setBusy(false);
    }
  }

  if (moved)
    return (
      <Surface className="space-y-4 p-5">
        <Notice tone="success">
          {t(
            moved.status === 'pending' ? 'patient.reschedule.requested' : 'patient.reschedule.done',
            {
              date: shortDate(moved.date, locale),
              time: moved.startTime,
            },
          )}
        </Notice>
        <Button asChild>
          <Link href="/app/appointments">{t('patient.nav.appointments')}</Link>
        </Button>
      </Surface>
    );
  if (!eligible) return <Notice tone="info">{t('patient.reschedule.clinic')}</Notice>;
  return (
    <Surface className="space-y-5 p-5">
      <p className="font-medium">
        {appointment.patient.name} · {appointment.doctorName ?? appointment.clinicName}
      </p>
      <p>
        {t('patient.reschedule.current', {
          date: shortDate(appointment.date, locale),
          time: appointment.startTime,
        })}
      </p>
      <p className="text-sm text-muted-foreground">
        {t('patient.reschedule.policy', { minutes: options.cancelCutoffMinutes })}
      </p>
      {error && <Notice tone="error">{error}</Notice>}
      {uncertain && <Notice tone="info">{t('patient.reschedule.recover')}</Notice>}
      <fieldset disabled={busy || uncertain} className="space-y-4">
        <legend className="mb-2 text-sm font-medium">{t('patient.book.date')}</legend>
        <DateStrip
          dates={days.map((date) => ({ date, open: true }))}
          selected={date}
          onSelect={setDate}
        />
        <div data-testid="slots" className="space-y-2">
          <p className="text-sm font-medium">{t('patient.book.time')}</p>
          {day.status === 'loading' && <Loading />}
          {day.status === 'error' && <LoadError error={day.error} retry={loadDay} />}
          {day.status === 'ready' &&
            (day.data.closed ? (
              <p>{t(`patient.book.closed.${day.data.closed}`, { days: options.horizonDays })}</p>
            ) : (
              <SlotPicker
                slots={day.data.slots.map((s) =>
                  s.start === appointment.startAt ? { ...s, available: false } : s,
                )}
                selected={slot?.start}
                onSelect={(slot) => {
                  setSlot(slot);
                  setAttempt(newAttemptKey());
                  setError(null);
                }}
                closedMessage={t('patient.book.noSlots')}
              />
            ))}
        </div>
      </fieldset>
      <Button className="w-full" disabled={!slot || busy} onClick={() => void move()}>
        {t(uncertain ? 'patient.reschedule.retry' : 'patient.reschedule.confirm')}
      </Button>
      <Link className="text-sm underline" href="/app/appointments">
        {t('patient.nav.appointments')}
      </Link>
    </Surface>
  );
}
