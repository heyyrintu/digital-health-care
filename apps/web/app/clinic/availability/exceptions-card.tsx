'use client';

import { ApiError } from '@dhc/api-client';
import {
  AvailabilityException,
  AvailabilityExceptionList,
  type AvailabilityExceptionType,
} from '@dhc/contracts';
import { Button, cn, Input, Label, NativeSelect } from '@dhc/ui-web';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useSession } from '../session-provider';
import type { Selection } from './selection';

/**
 * Leave (the doctor, every clinic), clinic holidays (admins) and extra sessions (this
 * clinic and consultation type). Each can be removed until it starts.
 */
export function ExceptionsCard({ selection }: { selection: Selection }) {
  const { api, signOut, t } = useSession();
  const { doctorId, clinic, clinics, type, canEdit, isAdmin, today, changed } = selection;
  const [items, setItems] = useState<AvailabilityException[] | null>(null);
  const [kind, setKind] = useState<AvailabilityExceptionType>('leave');
  const [startDate, setStartDate] = useState(today);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handle = useCallback(
    (e: unknown) => {
      if (e instanceof ApiError && e.status === 401) return void signOut('expired');
      setError(e instanceof ApiError ? e.message : t('error.network'));
    },
    [signOut, t],
  );

  const load = useCallback(async () => {
    const list = await api.request('GET', '/availability/exceptions', {
      schema: AvailabilityExceptionList,
      query: { doctorId },
    });
    setItems(list.data);
  }, [api, doctorId]);

  useEffect(() => {
    load().catch(handle);
  }, [load, handle]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await load();
      changed();
    } catch (e) {
      handle(e);
    } finally {
      setBusy(false);
    }
  }

  function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const text = (name: string) => String(data.get(name) ?? '').trim() || null;
    void run(async () => {
      await api.request('POST', '/availability/exceptions', {
        schema: AvailabilityException,
        body: {
          type: kind,
          doctorUserId: kind === 'holiday' ? null : doctorId,
          clinicId: kind === 'leave' ? null : clinic.id,
          consultationTypeId: kind === 'extra_session' ? type.id : null,
          startDate,
          endDate: text('endDate') ?? startDate,
          startTime: text('startTime'),
          endTime: text('endTime'),
          reason: text('reason'),
        },
      });
      form.reset();
    });
  }

  const canRemove = (e: AvailabilityException) =>
    e.startDate > today && (e.type === 'holiday' ? isAdmin : canEdit);

  const clinicName = (id: string | null) =>
    id ? (clinics.find((c) => c.id === id)?.name ?? '') : t('availability.allClinics');

  const kinds: AvailabilityExceptionType[] = isAdmin
    ? ['leave', 'extra_session', 'holiday']
    : ['leave', 'extra_session'];

  return (
    <section aria-labelledby="exceptions-title" className="surface space-y-5 p-5 sm:p-6">
      <h2 id="exceptions-title" className="font-display text-lg font-bold">
        {t('availability.exceptionsTitle')}
      </h2>
      {items && items.length === 0 && (
        <p className="rounded-xl bg-muted p-4 text-sm text-muted-foreground">
          {t('availability.noExceptions')}
        </p>
      )}
      {items && items.length > 0 && (
        <ul className="space-y-2" data-testid="exceptions">
          {items.map((e) => (
            <li
              key={e.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-border/60 bg-background/60 p-3"
            >
              <strong
                className={cn(
                  'inline-flex min-h-6 items-center rounded-full px-2.5 py-0.5 text-xs font-semibold',
                  e.type === 'extra_session'
                    ? 'bg-success-soft text-success'
                    : e.type === 'holiday'
                      ? 'bg-info-soft text-info'
                      : 'bg-warning-soft text-warning-foreground',
                )}
              >
                {t(`exception.${e.type}`)}
              </strong>
              <span className="min-w-0 flex-1 basis-48 text-sm">
                {e.startDate === e.endDate ? e.startDate : `${e.startDate} – ${e.endDate}`} ·{' '}
                {e.startTime ? `${e.startTime}–${e.endTime}` : t('availability.allDay')} ·{' '}
                {clinicName(e.clinicId)}
                {e.reason && ` · ${e.reason}`}
              </span>
              {canRemove(e) && (
                <Button
                  type="button"
                  variant="outline"
                  className="ml-auto"
                  disabled={busy}
                  onClick={() => void run(() => api.deleteAvailabilityException(e.id))}
                >
                  {t('availability.remove')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {canEdit && (
        <form
          className="grid grid-cols-[repeat(auto-fit,minmax(9.5rem,1fr))] items-end gap-4 border-t border-border/60 pt-5"
          onSubmit={add}
        >
          <div className="space-y-2">
            <Label htmlFor="exception-type">{t('availability.exceptionType')}</Label>
            <NativeSelect
              id="exception-type"
              value={kind}
              onChange={(e) => setKind(e.target.value as AvailabilityExceptionType)}
            >
              {kinds.map((k) => (
                <option key={k} value={k}>
                  {t(`exception.${k}`)}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="space-y-2">
            <Label htmlFor="exception-start">{t('availability.startDate')}</Label>
            <Input
              id="exception-start"
              type="date"
              min={today}
              required
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="exception-end">{t('availability.endDate')}</Label>
            <Input id="exception-end" name="endDate" type="date" min={startDate} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="exception-start-time">{t('availability.startTime')}</Label>
            <Input
              id="exception-start-time"
              name="startTime"
              type="time"
              required={kind === 'extra_session'}
              aria-describedby="exception-times-hint"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="exception-end-time">{t('availability.endTime')}</Label>
            <Input
              id="exception-end-time"
              name="endTime"
              type="time"
              required={kind === 'extra_session'}
            />
          </div>
          <div className="col-span-full space-y-2">
            <Label htmlFor="exception-reason">{t('availability.reason')}</Label>
            <Input id="exception-reason" name="reason" maxLength={200} />
          </div>
          <Button
            type="submit"
            className="col-span-full sm:w-auto sm:justify-self-start"
            disabled={busy}
          >
            {t('availability.addException')}
          </Button>
        </form>
      )}
      {canEdit && kind !== 'extra_session' && (
        <p id="exception-times-hint" className="text-xs text-muted-foreground">
          {t('availability.timesHint')}
        </p>
      )}
      {error && (
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
