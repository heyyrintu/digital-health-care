import { ApiError } from '@dhc/api-client';
import type { BookingOptions, PortalAppointment, Slot } from '@dhc/contracts';
import { Button, Card, Choice, Notice, Text, TextField, useTheme } from '@dhc/ui-native';
import { router } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';
import { api } from '../../api';
import { errorMessage } from '../../errors';
import { useLocale } from '../../locale/provider';
import { useLoad } from '../../use-load';
import type { ReadyAccount } from '../gate';
import { bookingDays, dayPart, istToday, rupees, shortDate, type DayPart } from '../logic';
import { ChoiceRow, LoadError, Loading, PatientPicker, PatientScreen } from '../parts';

const PARTS: DayPart[] = ['morning', 'afternoon', 'evening'];

const newAttemptKey = () =>
  `book-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

/** PRD §4.3: patient → doctor → clinic → consultation → date → slot → reason → book. */
export function BookScreen({ account }: { account: ReadyAccount }) {
  const { t } = useLocale();
  const { state, reload } = useLoad(() => api.bookingOptions(), []);
  return (
    <PatientScreen title={t('patient.book.title')}>
      {state.status === 'loading' && <Loading />}
      {state.status === 'error' && <LoadError error={state.error} retry={reload} />}
      {state.status === 'ready' &&
        (state.data.doctors.length &&
        state.data.clinics.length &&
        state.data.consultationTypes.length ? (
          <BookForm options={state.data} account={account} />
        ) : (
          <Notice>{t('patient.book.nothing')}</Notice>
        ))}
    </PatientScreen>
  );
}

function BookForm({ options, account }: { options: BookingOptions; account: ReadyAccount }) {
  const { t, locale } = useLocale();
  const theme = useTheme();
  const [patientId, setPatientId] = useState(account.selected.id);
  const [doctorId, setDoctorId] = useState(options.doctors[0]!.userId);
  const [clinicId, setClinicId] = useState(options.clinics[0]!.id);
  const [typeId, setTypeId] = useState(options.consultationTypes[0]!.id);
  // Every day the clinic takes bookings for; the row wraps.
  const days = useMemo(
    () => bookingDays(istToday(new Date()), options.horizonDays, options.horizonDays + 1),
    [options],
  );
  const [date, setDate] = useState(days[0]!);
  const [slot, setSlot] = useState<Slot | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [booked, setBooked] = useState<PortalAppointment | null>(null);

  const slots = useLoad(
    () => api.portalSlots({ doctorId, clinicId, consultationTypeId: typeId, date }),
    [doctorId, clinicId, typeId, date],
  );
  useEffect(() => setSlot(null), [doctorId, clinicId, typeId, date]);
  const type = options.consultationTypes.find((c) => c.id === typeId)!;
  // One key per booking attempt, so a retry after a lost response never books twice.
  const attempt = useMemo(
    () => newAttemptKey(),
    [patientId, doctorId, clinicId, typeId, slot?.start, reason],
  );

  const book = async () => {
    if (!slot) return;
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
      setError(errorMessage(e, t));
      // Someone took the slot meanwhile: show the day as it is now.
      if (e instanceof ApiError && e.code === 'SLOT_TAKEN') {
        setSlot(null);
        void slots.reload();
      }
    } finally {
      setBusy(false);
    }
  };

  if (booked) {
    const when = { date: shortDate(booked.date, locale), time: booked.startTime };
    return (
      <Card>
        <Notice tone="success">
          {booked.status === 'pending'
            ? t('patient.book.requested', when)
            : t('patient.book.booked', { ...when, token: booked.tokenNumber })}
        </Notice>
        <Button
          label={t('patient.nav.appointments')}
          onPress={() => router.replace('/appointments')}
        />
      </Card>
    );
  }

  return (
    <>
      {error && <Notice tone="error">{error}</Notice>}
      <PatientPicker
        label={t('patient.book.for')}
        patients={account.patients}
        selectedId={patientId}
        onSelect={setPatientId}
      />
      {options.doctors.length > 1 && (
        <ChoiceRow label={t('patient.book.doctor')}>
          {options.doctors.map((d, i) => (
            <Choice
              key={d.userId}
              label={d.displayName ?? `${t('patient.book.doctor')} ${i + 1}`}
              selected={d.userId === doctorId}
              onPress={() => setDoctorId(d.userId)}
            />
          ))}
        </ChoiceRow>
      )}
      {options.clinics.length > 1 && (
        <ChoiceRow label={t('patient.book.clinic')}>
          {options.clinics.map((c) => (
            <Choice
              key={c.id}
              label={c.name}
              selected={c.id === clinicId}
              onPress={() => setClinicId(c.id)}
            />
          ))}
        </ChoiceRow>
      )}
      {options.consultationTypes.length > 1 && (
        <ChoiceRow label={t('patient.book.type')}>
          {options.consultationTypes.map((c) => (
            <Choice
              key={c.id}
              label={c.name}
              selected={c.id === typeId}
              onPress={() => setTypeId(c.id)}
            />
          ))}
        </ChoiceRow>
      )}
      <ChoiceRow label={t('patient.book.date')}>
        {days.map((d) => (
          <Choice
            key={d}
            label={shortDate(d, locale)}
            selected={d === date}
            onPress={() => setDate(d)}
          />
        ))}
      </ChoiceRow>

      <View style={{ gap: theme.spacing[3] }}>
        <Text variant="label">{t('patient.book.time')}</Text>
        {slots.state.status === 'loading' && <Loading />}
        {slots.state.status === 'error' && (
          <LoadError error={slots.state.error} retry={slots.reload} />
        )}
        {slots.state.status === 'ready' &&
          (slots.state.data.closed ? (
            <Text variant="muted">
              {t(`patient.book.closed.${slots.state.data.closed}`, { days: options.horizonDays })}
            </Text>
          ) : slots.state.data.slots.some((s) => s.available) ? (
            PARTS.map((part) => {
              const inPart =
                slots.state.status === 'ready'
                  ? slots.state.data.slots.filter((s) => dayPart(s.startTime) === part)
                  : [];
              if (!inPart.length) return null;
              return (
                <ChoiceRow key={part} label={t(`patient.book.${part}`)}>
                  {inPart.map((s) => (
                    <Choice
                      key={s.start}
                      label={s.startTime}
                      selected={slot?.start === s.start}
                      disabled={!s.available}
                      hint={s.available ? undefined : t('patient.book.taken')}
                      onPress={() => setSlot(s)}
                    />
                  ))}
                </ChoiceRow>
              );
            })
          ) : (
            <Text variant="muted">{t('patient.book.noSlots')}</Text>
          ))}
      </View>

      <TextField
        label={t('patient.book.reason')}
        value={reason}
        onChangeText={setReason}
        maxLength={300}
      />
      <Text variant="muted">{t('patient.book.fee', { fee: rupees(type.feePaise, locale) })}</Text>
      <Text variant="muted">
        {t('patient.book.policy', { minutes: options.cancelCutoffMinutes })}
      </Text>
      <Button
        label={
          slot
            ? t('patient.book.confirm', { time: slot.startTime, date: shortDate(date, locale) })
            : t('booking.book')
        }
        disabled={!slot}
        loading={busy}
        onPress={book}
      />
    </>
  );
}
