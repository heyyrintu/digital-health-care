'use client';

import type { Appointment, AppointmentAction } from '@dhc/contracts';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { AgeGender, TagChip } from '../patient-bits';
import { useSession } from '../session-provider';
import { actionsFor, canReschedule } from './rules';

const minutesSince = (iso: string | null, now: Date) =>
  iso ? Math.max(0, Math.floor((now.getTime() - Date.parse(iso)) / 60_000)) : 0;

/**
 * One queue card (PRD §5.1): token, booked time or walk-in, waiting time, patient,
 * tags, status, and the actions this person may take.
 */
export function AppointmentRow({
  a,
  me,
  today,
  now,
  busy,
  onAct,
}: {
  a: Appointment;
  me: { role: string; userId: string };
  today: string;
  now: Date;
  busy: boolean;
  onAct(a: Appointment, action: AppointmentAction, reason?: string): Promise<void>;
}) {
  const { t } = useSession();
  const [cancelling, setCancelling] = useState(false);
  const actions = actionsFor(a, me, today, now);

  async function cancel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const reason = String(new FormData(event.currentTarget).get('reason') ?? '').trim();
    await onAct(a, 'cancel', reason);
  }

  return (
    <li data-testid={`appointment-${a.patient.uhid}`} className={`appt status-${a.status}`}>
      <div className="appt-token" aria-label={`${t('appointments.token')} ${a.tokenNumber}`}>
        {a.tokenNumber}
      </div>
      <div className="appt-main">
        <p>
          <strong>{a.source === 'walk_in' ? t('appointments.walkInBadge') : a.startTime}</strong> ·{' '}
          <Link href={`/clinic/patients/${a.patient.id}`}>{a.patient.name}</Link> · {a.patient.uhid}{' '}
          · <AgeGender patient={a.patient} />
        </p>
        <p className="hint">
          {a.doctorName ?? t('availability.doctor')} · {a.consultationTypeName}
          {a.reason && ` · ${a.reason}`}
        </p>
        <p>
          <span className="pill" data-testid="appointment-status">
            {t(`status.${a.status}`)}
          </span>
          {a.status === 'checked_in' && (
            <span className="pill waiting" data-testid="waiting-time">
              {t('queue.waiting', { minutes: minutesSince(a.checkedInAt, now) })}
            </span>
          )}
          {a.status === 'in_consultation' && (
            <span className="pill">
              {t('queue.withDoctor', { minutes: minutesSince(a.consultationStartedAt, now) })}
            </span>
          )}
          {a.status === 'pending' && <span className="pill">{t('queue.awaiting')}</span>}
          {a.overbook && <span className="pill">{t('appointments.overbookBadge')}</span>}
          {a.patient.tags.map((tag) => (
            <TagChip key={tag.id} tag={tag} />
          ))}
          {a.cancelReason && <span className="hint"> {a.cancelReason}</span>}
        </p>
        {cancelling && (
          <form className="inline-form" onSubmit={(e) => void cancel(e)}>
            <div>
              <label htmlFor={`reason-${a.id}`}>{t('appointments.cancelReason')}</label>
              <input id={`reason-${a.id}`} name="reason" required maxLength={300} />
            </div>
            <button type="submit" disabled={busy}>
              {t('action.cancel')}
            </button>
            <button type="button" className="secondary" onClick={() => setCancelling(false)}>
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
              disabled={busy}
              onClick={() => void onAct(a, action)}
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
        {actions.includes('cancel') && !cancelling && (
          <button type="button" className="secondary" onClick={() => setCancelling(true)}>
            {t('action.cancel')}
          </button>
        )}
      </div>
    </li>
  );
}
