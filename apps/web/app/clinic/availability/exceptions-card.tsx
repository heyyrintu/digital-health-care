'use client';

import { ApiError } from '@dhc/api-client';
import {
  AvailabilityException,
  AvailabilityExceptionList,
  type AvailabilityExceptionType,
} from '@dhc/contracts';
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
    <section aria-labelledby="exceptions-title" className="card">
      <h2 id="exceptions-title">{t('availability.exceptionsTitle')}</h2>
      {items && items.length === 0 && <p>{t('availability.noExceptions')}</p>}
      {items && items.length > 0 && (
        <ul className="tag-list" data-testid="exceptions">
          {items.map((e) => (
            <li key={e.id}>
              <strong>{t(`exception.${e.type}`)}</strong>
              <span>
                {e.startDate === e.endDate ? e.startDate : `${e.startDate} – ${e.endDate}`} ·{' '}
                {e.startTime ? `${e.startTime}–${e.endTime}` : t('availability.allDay')} ·{' '}
                {clinicName(e.clinicId)}
                {e.reason && ` · ${e.reason}`}
              </span>
              {canRemove(e) && (
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => void run(() => api.deleteAvailabilityException(e.id))}
                >
                  {t('availability.remove')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {canEdit && (
        <form className="inline-form" onSubmit={add}>
          <div>
            <label htmlFor="exception-type">{t('availability.exceptionType')}</label>
            <select
              id="exception-type"
              value={kind}
              onChange={(e) => setKind(e.target.value as AvailabilityExceptionType)}
            >
              {kinds.map((k) => (
                <option key={k} value={k}>
                  {t(`exception.${k}`)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="exception-start">{t('availability.startDate')}</label>
            <input
              id="exception-start"
              type="date"
              min={today}
              required
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="exception-end">{t('availability.endDate')}</label>
            <input id="exception-end" name="endDate" type="date" min={startDate} />
          </div>
          <div>
            <label htmlFor="exception-start-time">{t('availability.startTime')}</label>
            <input
              id="exception-start-time"
              name="startTime"
              type="time"
              required={kind === 'extra_session'}
              aria-describedby="exception-times-hint"
            />
          </div>
          <div>
            <label htmlFor="exception-end-time">{t('availability.endTime')}</label>
            <input
              id="exception-end-time"
              name="endTime"
              type="time"
              required={kind === 'extra_session'}
            />
          </div>
          <div>
            <label htmlFor="exception-reason">{t('availability.reason')}</label>
            <input id="exception-reason" name="reason" maxLength={200} />
          </div>
          <button type="submit" disabled={busy}>
            {t('availability.addException')}
          </button>
        </form>
      )}
      {canEdit && kind !== 'extra_session' && (
        <p id="exception-times-hint" className="hint">
          {t('availability.timesHint')}
        </p>
      )}
      {error && (
        <p role="alert" className="alert">
          {error}
        </p>
      )}
    </section>
  );
}
