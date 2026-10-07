'use client';

import { ApiError } from '@dhc/api-client';
import { SlotsResponse } from '@dhc/contracts';
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
    <section aria-labelledby="preview-title" className="card">
      <h2 id="preview-title">{t('availability.previewTitle')}</h2>
      <div className="inline-form">
        <div>
          <label htmlFor="preview-date">{t('availability.previewDate')}</label>
          <input
            id="preview-date"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={asPatient}
            onChange={(e) => setAsPatient(e.target.checked)}
          />{' '}
          {t('availability.asPatient')}
        </label>
      </div>
      {error && (
        <p role="alert" className="alert">
          {error}
        </p>
      )}
      <div aria-live="polite" data-testid="slots">
        {day?.closed && <p>{t(`closed.${day.closed}`)}</p>}
        {day && day.slots.length > 0 && (
          <>
            <p className="hint" data-testid="slot-count">
              {t('availability.slotCount', { available: open, total: day.slots.length })}
            </p>
            <ul className="slot-grid">
              {day.slots.map((s) => (
                <li
                  key={s.start}
                  className={s.available ? undefined : 'unavailable'}
                  data-testid={`slot-${s.startTime}`}
                >
                  {s.startTime}
                  {s.unavailableReason && (
                    <span className="visually-hidden"> ({t(`slot.${s.unavailableReason}`)})</span>
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
