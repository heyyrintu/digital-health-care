'use client';

import { ApiError } from '@dhc/api-client';
import { SlotsResponse } from '@dhc/contracts';
import { cn, Input, Label } from '@dhc/ui-web';
import { useEffect, useState } from 'react';
import { useSession } from '../session-provider';
import type { Selection } from './selection';

/** The slots one day offers, as staff or (optionally) as patients will see them online. */
export function SlotPreview({ selection }: { selection: Selection }) {
  const { api, signOut, t } = useSession();
  const { doctorId, clinic, type, today, version } = selection;
  const [date, setDate] = useState(today);
  const [asPatient, setAsPatient] = useState(false);
  const [day, setDay] = useState<SlotsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!date) return;
    let cancelled = false;
    setError(null);
    // Never leave another day's slots on screen while loading or after a failure.
    setDay(null);
    api
      .request('GET', '/slots', {
        schema: SlotsResponse,
        query: {
          doctorId,
          clinicId: clinic.id,
          consultationTypeId: type.id,
          date,
          channel: asPatient ? 'patient' : 'staff',
        },
      })
      .then((result) => !cancelled && setDay(result))
      .catch((e: unknown) => {
        if (cancelled) return;
        if (e instanceof ApiError && e.status === 401) return void signOut('expired');
        setError(e instanceof ApiError ? e.message : t('error.network'));
      });
    return () => {
      cancelled = true;
    };
  }, [api, signOut, t, doctorId, clinic.id, type.id, date, asPatient, version]);

  const open = day?.slots.filter((s) => s.available).length ?? 0;

  return (
    <section aria-labelledby="preview-title" className="surface space-y-5 p-5 sm:p-6">
      <h2 id="preview-title" className="font-display text-lg font-bold">
        {t('availability.previewTitle')}
      </h2>
      <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
        <div className="min-w-40 flex-1 space-y-2">
          <Label htmlFor="preview-date">{t('availability.previewDate')}</Label>
          <Input
            id="preview-date"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>
        <label className="flex min-h-11 cursor-pointer items-center gap-2.5 text-sm font-medium">
          <input
            type="checkbox"
            className="size-4 accent-primary"
            checked={asPatient}
            onChange={(e) => setAsPatient(e.target.checked)}
          />{' '}
          {t('availability.asPatient')}
        </label>
      </div>
      {error && (
        <p
          role="alert"
          className="rounded-xl bg-danger-soft p-4 text-sm font-medium text-destructive"
        >
          {error}
        </p>
      )}
      <div aria-live="polite" data-testid="slots">
        {day?.closed && (
          <p className="rounded-xl bg-muted p-4 text-center text-sm text-muted-foreground">
            {t(`closed.${day.closed}`)}
          </p>
        )}
        {day && day.slots.length > 0 && (
          <>
            <p
              className="mb-3 text-xs font-semibold text-muted-foreground"
              data-testid="slot-count"
            >
              {t('availability.slotCount', { available: open, total: day.slots.length })}
            </p>
            <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-3">
              {day.slots.map((s) => (
                <li
                  key={s.start}
                  className={cn(
                    'tabular flex min-h-11 items-center justify-center rounded-full border px-2 py-2 text-sm font-semibold',
                    s.available
                      ? 'border-border/70 bg-card'
                      : 'border-transparent bg-muted text-muted-foreground line-through',
                  )}
                  data-testid={`slot-${s.startTime}`}
                >
                  {s.startTime}
                  {s.unavailableReason && (
                    <span className="sr-only"> ({t(`slot.${s.unavailableReason}`)})</span>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </section>
  );
}
