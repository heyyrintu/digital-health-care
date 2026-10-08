'use client';

import type { Appointment, AppointmentAction } from '@dhc/contracts';
import { Button, buttonVariants, cn, Input, Label, ModeTag, StatusChip } from '@dhc/ui-web';
import { formatInr } from '@dhc/domain';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { AgeGender, TagChip } from '../patient-bits';
import { useSession } from '../session-provider';
import { actionsFor, canBill, canConsult, canRecordVitals, canReschedule } from './rules';

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
  const { locale, t } = useSession();
  const [cancelling, setCancelling] = useState(false);
  const actions = actionsFor(a, me, today, now);

  async function cancel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const reason = String(new FormData(event.currentTarget).get('reason') ?? '').trim();
    await onAct(a, 'cancel', reason);
  }

  const closed = ['cancelled', 'no_show', 'rescheduled'].includes(a.status);
  const pill = 'inline-flex min-h-6 items-center rounded-full px-2.5 py-0.5 text-xs font-semibold';
  const small = 'h-11 min-h-11 sm:h-9 sm:min-h-9';

  return (
    <li
      data-testid={`appointment-${a.patient.uhid}`}
      className={cn(
        `appt status-${a.status}`,
        'grid grid-cols-[3.5rem_minmax(0,1fr)] items-start gap-x-4 gap-y-3 p-4 sm:p-5 lg:grid-cols-[3.5rem_minmax(0,1fr)_auto]',
        closed && 'text-muted-foreground',
      )}
    >
      <div
        className={cn(
          'appt-token',
          'tabular grid h-14 w-14 place-items-center rounded-2xl font-display text-2xl font-extrabold',
          a.status === 'in_consultation'
            ? 'bg-primary text-primary-foreground shadow-button'
            : closed
              ? 'bg-muted text-muted-foreground'
              : 'bg-accent text-accent-foreground',
        )}
        aria-label={`${t('appointments.token')} ${a.tokenNumber}`}
      >
        {a.tokenNumber}
      </div>
      <div className="min-w-0 space-y-1.5">
        <p className="text-sm">
          <strong className="tabular font-semibold">
            {a.source === 'walk_in' ? t('appointments.walkInBadge') : a.startTime}
          </strong>{' '}
          ·{' '}
          <Link
            href={`/clinic/patients/${a.patient.id}`}
            className="font-display text-base font-bold text-foreground underline-offset-4 hover:text-primary hover:underline"
          >
            {a.patient.name}
          </Link>{' '}
          · <span className="tabular">{a.patient.uhid}</span> · <AgeGender patient={a.patient} />
        </p>
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span>
            {a.doctorName ?? t('availability.doctor')} · {a.consultationTypeName}
            {a.reason && ` · ${a.reason}`}
          </span>
          <ModeTag mode={a.mode} />
        </p>
        <p className="flex flex-wrap items-center gap-1.5 pt-0.5">
          <span data-testid="appointment-status" className="inline-flex">
            <StatusChip status={a.status} />
          </span>
          {a.status === 'checked_in' && (
            <span
              className={cn(pill, 'tabular bg-warning-soft text-warning-foreground')}
              data-testid="waiting-time"
            >
              {t('queue.waiting', { minutes: minutesSince(a.checkedInAt, now) })}
            </span>
          )}
          {a.status === 'in_consultation' && (
            <span className={cn(pill, 'tabular bg-accent text-accent-foreground')}>
              {t('queue.withDoctor', { minutes: minutesSince(a.consultationStartedAt, now) })}
            </span>
          )}
          {a.status === 'pending' && (
            <span className={cn(pill, 'bg-muted text-muted-foreground')}>
              {t('queue.awaiting')}
            </span>
          )}
          {a.bill && (
            <span
              data-testid="bill-chip"
              className={cn(
                pill,
                'tabular',
                a.bill.status === 'paid'
                  ? 'bg-success-soft text-success'
                  : 'bg-warning-soft text-warning-foreground',
              )}
            >
              {t('billing.chip', {
                amount: formatInr(a.bill.totalPaise, locale),
                status: t(`billing.status.${a.bill.status}`),
              })}
            </span>
          )}
          {a.overbook && (
            <span className={cn(pill, 'bg-warning-soft text-warning-foreground')}>
              {t('appointments.overbookBadge')}
            </span>
          )}
          {a.patient.tags.map((tag) => (
            <TagChip key={tag.id} tag={tag} />
          ))}
          {a.cancelReason && (
            <span className="text-xs text-muted-foreground"> {a.cancelReason}</span>
          )}
        </p>
        {cancelling && (
          <form
            className="mt-3 flex flex-col gap-3 rounded-xl border border-border/60 bg-background/60 p-3 sm:flex-row sm:items-end"
            onSubmit={(e) => void cancel(e)}
          >
            <div className="min-w-0 flex-1 space-y-2">
              <Label htmlFor={`reason-${a.id}`}>{t('appointments.cancelReason')}</Label>
              <Input id={`reason-${a.id}`} name="reason" required maxLength={300} />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" variant="destructive" disabled={busy}>
                {t('action.cancel')}
              </Button>
              <Button type="button" variant="outline" onClick={() => setCancelling(false)}>
                {t('appointments.keep')}
              </Button>
            </div>
          </form>
        )}
      </div>
      <div className="appt-actions col-span-full flex flex-wrap gap-2 lg:col-span-1 lg:max-w-xs lg:justify-end">
        {actions
          .filter((action) => action !== 'cancel')
          .map((action) => (
            <Button
              key={action}
              type="button"
              size="sm"
              variant={action === 'no_show' ? 'outline' : 'default'}
              className={small}
              disabled={busy}
              onClick={() => void onAct(a, action)}
            >
              {t(`action.${action}`)}
            </Button>
          ))}
        {canConsult(a, me.role) && (
          <Link
            className={buttonVariants({ size: 'sm', className: small })}
            href={`/clinic/consultations/${a.id}`}
          >
            {t('action.consult')}
          </Link>
        )}
        {canRecordVitals(a, me.role, today) && (
          <Link
            className={buttonVariants({ variant: 'outline', size: 'sm', className: small })}
            href={`/clinic/appointments/${a.id}/vitals`}
          >
            {t('action.vitals')}
          </Link>
        )}
        {canBill(a, me.role) && (
          <Link
            className={buttonVariants({ variant: 'outline', size: 'sm', className: small })}
            href={`/clinic/appointments/${a.id}/bill`}
          >
            {t('action.bill')}
          </Link>
        )}
        {canReschedule(a, me.role) && (
          <Link
            className={buttonVariants({ variant: 'outline', size: 'sm', className: small })}
            href={`/clinic/appointments/new?reschedule=${a.id}`}
          >
            {t('action.reschedule')}
          </Link>
        )}
        {actions.includes('cancel') && !cancelling && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className={cn(small, 'text-destructive hover:text-destructive')}
            onClick={() => setCancelling(true)}
          >
            {t('action.cancel')}
          </Button>
        )}
      </div>
    </li>
  );
}
