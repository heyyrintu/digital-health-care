'use client';

import type { BookingOptions, PortalAppointment, Slot, SlotsResponse } from '@dhc/contracts';
import { formatInr, istDateKey, shortDate } from '@dhc/domain';
import { Button, DateStrip, Field, SlotPicker, Surface, Textarea } from '@dhc/ui-web';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  bookingDates,
  canBookOnline,
  keepAttemptKey,
  newAttemptKey,
  portalErrorMessage,
  slotTaken,
} from '../../../lib/patient';
import { ChoiceGroup, LoadError, Loading, Notice, PatientPicker, PortalPage } from '../parts';
import { usePatientSession } from '../session-provider';
import { PortalShell, type ReadyAccount } from '../shell';

/** PRD §4.3: patient → doctor → clinic → consultation → date → slot → reason → book. */
export default function BookPage() {
  return <PortalShell>{(account) => <Book account={account} />}</PortalShell>;
}

type Load<T> =
  { status: 'loading' } | { status: 'error'; error: unknown } | { status: 'ready'; data: T };

function Book({ account }: { account: ReadyAccount }) {
  const { api, t } = usePatientSession();
  const [options, setOptions] = useState<Load<BookingOptions>>({ status: 'loading' });

  const load = useCallback(() => {
    setOptions({ status: 'loading' });
    api
      .bookingOptions()
      .then((data) => setOptions({ status: 'ready', data }))
      .catch((error: unknown) => setOptions({ status: 'error', error }));
  }, [api]);
  useEffect(load, [load]);

  return (
    <PortalPage title={t('patient.book.title')}>
      {options.status === 'loading' && <Loading />}
      {options.status === 'error' && <LoadError error={options.error} retry={load} />}
      {options.status === 'ready' &&
        (canBookOnline(options.data) ? (
          <BookForm options={options.data} account={account} />
        ) : (
          <Notice tone="info">{t('patient.book.nothing')}</Notice>
        ))}
    </PortalPage>
  );
}

function BookForm({ options, account }: { options: BookingOptions; account: ReadyAccount }) {
  const { api, locale, t } = usePatientSession();
  const [patientId, setPatientId] = useState(account.selected.id);
  const [doctorId, setDoctorId] = useState(options.doctors[0]!.userId);
  const [clinicId, setClinicId] = useState(options.clinics[0]!.id);
  const [typeId, setTypeId] = useState(options.consultationTypes[0]!.id);
  const days = useMemo(() => bookingDates(istDateKey(new Date()), options), [options]);
  const [date, setDate] = useState(days[0]!);
  const [day, setDay] = useState<Load<SlotsResponse>>({ status: 'loading' });
  const [slot, setSlot] = useState<Slot | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [booked, setBooked] = useState<PortalAppointment | null>(null);
  // One Idempotency-Key per booking attempt: a retry after a lost answer books once. A
  // changed choice is a new attempt.
  const [attempt, setAttempt] = useState(newAttemptKey);
  useEffect(
    () => setAttempt(newAttemptKey()),
    [patientId, doctorId, clinicId, typeId, slot, reason],
  );

  // Only the latest slots request may show its day: a retry or reload that answers after
  // the choice changed is dropped.
  const dayRequest = useRef(0);
  const loadDay = useCallback(() => {
    const id = ++dayRequest.current;
    const latest = () => id === dayRequest.current;
    setDay({ status: 'loading' });
    setSlot(null);
    api
      .portalSlots({ doctorId, clinicId, consultationTypeId: typeId, date })
      .then((data) => latest() && setDay({ status: 'ready', data }))
      .catch((e: unknown) => latest() && setDay({ status: 'error', error: e }));
  }, [api, doctorId, clinicId, typeId, date]);
  useEffect(() => {
    loadDay();
    return () => {
      dayRequest.current++;
    };
  }, [loadDay]);

  const type = options.consultationTypes.find((c) => c.id === typeId)!;

  async function book(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!slot) return setError(t('book.pickSlot'));
    setBusy(true);
    setError(null);
    try {
      setBooked(
        await api.bookPortalAppointment(
          {
            patientId,
            doctorUserId: doctorId,
            clinicId,
            consultationTypeId: typeId,
            startAt: slot.start,
            ...(reason.trim() ? { reason: reason.trim() } : {}),
          },
          attempt,
        ),
      );
    } catch (e) {
      setError(portalErrorMessage(e, t));
      if (!keepAttemptKey(e)) setAttempt(newAttemptKey());
      // Someone took the slot meanwhile: show the day as it is now.
      if (slotTaken(e)) loadDay();
    } finally {
      setBusy(false);
    }
  }

  if (booked) {
    const when = { date: shortDate(booked.date, locale), time: booked.startTime };
    return (
      <Surface className="space-y-4 p-5 sm:p-6">
        <Notice tone="success">
          {booked.status === 'pending'
            ? t('patient.book.requested', when)
            : t('patient.book.booked', { ...when, token: booked.tokenNumber })}
        </Notice>
        <Button asChild className="w-full sm:w-auto">
          <Link href="/app/appointments">{t('patient.nav.appointments')}</Link>
        </Button>
      </Surface>
    );
  }

  const daySlots = day.status === 'ready' ? day.data : null;

  return (
    <form className="space-y-5" onSubmit={(e) => void book(e)} noValidate>
      {error && <Notice tone="error">{error}</Notice>}
      <Surface className="space-y-5 p-5 sm:p-6">
        <PatientPicker
          label={t('patient.book.for')}
          patients={account.patients}
          selectedId={patientId}
          onSelect={setPatientId}
        />
        {options.doctors.length > 1 && (
          <ChoiceGroup
            label={t('patient.book.doctor')}
            options={options.doctors.map((d, i) => ({
              value: d.userId,
              label: d.displayName ?? `${t('patient.book.doctor')} ${i + 1}`,
            }))}
            value={doctorId}
            onChange={setDoctorId}
          />
        )}
        {options.clinics.length > 1 && (
          <ChoiceGroup
            label={t('patient.book.clinic')}
            options={options.clinics.map((c) => ({ value: c.id, label: c.name }))}
            value={clinicId}
            onChange={setClinicId}
          />
        )}
        {options.consultationTypes.length > 1 && (
          <ChoiceGroup
            label={t('patient.book.type')}
            options={options.consultationTypes.map((c) => ({ value: c.id, label: c.name }))}
            value={typeId}
            onChange={setTypeId}
          />
        )}
        <div role="group" aria-labelledby="book-date" className="space-y-2">
          <p id="book-date" className="text-sm font-medium">
            {t('patient.book.date')}
          </p>
          <DateStrip
            dates={days.map((d) => ({ date: d, open: true }))}
            selected={date}
            onSelect={setDate}
          />
        </div>
        <div role="group" aria-labelledby="book-time" className="space-y-2" data-testid="slots">
          <p id="book-time" className="text-sm font-medium">
            {t('patient.book.time')}
          </p>
          {day.status === 'loading' && <Loading />}
          {day.status === 'error' && <LoadError error={day.error} retry={() => loadDay()} />}
          {daySlots &&
            (daySlots.closed ? (
              <p className="rounded-xl bg-muted p-4 text-center text-sm text-muted-foreground">
                {t(`patient.book.closed.${daySlots.closed}`, { days: options.horizonDays })}
              </p>
            ) : (
              <>
                {!daySlots.slots.some((s) => s.available) && (
                  <p className="text-sm text-muted-foreground">{t('patient.book.noSlots')}</p>
                )}
                <SlotPicker
                  slots={daySlots.slots}
                  selected={slot?.start}
                  onSelect={setSlot}
                  closedMessage={t('patient.book.noSlots')}
                />
              </>
            ))}
        </div>
        <Field label={t('patient.book.reason')}>
          <Textarea
            name="reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={300}
            rows={2}
          />
        </Field>
        <div className="space-y-1 text-sm text-muted-foreground">
          <p>{t('patient.book.fee', { fee: formatInr(type.feePaise, locale) })}</p>
          <p>{t('portal.book.policy', { minutes: options.cancelCutoffMinutes })}</p>
        </div>
        <Button type="submit" size="lg" className="w-full" disabled={!slot || busy}>
          {slot
            ? t('patient.book.confirm', { time: slot.startTime, date: shortDate(date, locale) })
            : t('booking.book')}
        </Button>
      </Surface>
    </form>
  );
}
