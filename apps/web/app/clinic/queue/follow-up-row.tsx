'use client';

import type { FollowUp } from '@dhc/contracts';
import { buttonVariants, cn, StatusChip } from '@dhc/ui-web';
import { CalendarPlus } from 'lucide-react';
import Link from 'next/link';
import { AgeGender, TagChip } from '../patient-bits';
import { useSession } from '../session-provider';

/**
 * A patient due back on the day (PRD §5.1 Follow-ups): the visit that asked for it, and
 * the booking for it, or a button to book one.
 */
export function FollowUpRow({ f, canBook }: { f: FollowUp; canBook: boolean }) {
  const { locale, t } = useSession();
  const day = (date: string) =>
    new Date(`${date}T00:00:00Z`).toLocaleDateString(locale === 'hi' ? 'hi-IN' : 'en-IN', {
      day: 'numeric',
      month: 'short',
      timeZone: 'UTC',
    });

  return (
    <li
      data-testid={`follow-up-${f.patient.uhid}`}
      className="grid items-start gap-x-4 gap-y-3 p-4 sm:p-5 lg:grid-cols-[minmax(0,1fr)_auto]"
    >
      <div className="min-w-0 space-y-1.5">
        <p className="text-sm">
          <Link
            href={`/clinic/patients/${f.patient.id}`}
            className="font-display text-base font-bold text-foreground underline-offset-4 hover:text-primary hover:underline"
          >
            {f.patient.name}
          </Link>{' '}
          · <span className="tabular">{f.patient.uhid}</span> · <AgeGender patient={f.patient} />
        </p>
        <p className="text-xs text-muted-foreground">
          {t('queue.followUp.seen', {
            date: day(f.visitDate),
            doctor: f.doctorName ?? t('availability.doctor'),
          })}
        </p>
        <p className="flex flex-wrap items-center gap-1.5 pt-0.5">
          {f.booking ? (
            <>
              <span className="tabular text-xs font-semibold" data-testid="follow-up-booking">
                {t('queue.followUp.booked', {
                  date: day(f.booking.date),
                  time: f.booking.startTime,
                })}
              </span>
              <StatusChip status={f.booking.status} />
            </>
          ) : (
            <span
              className="inline-flex min-h-6 items-center rounded-full bg-warning-soft px-2.5 py-0.5 text-xs font-semibold text-warning-foreground"
              data-testid="follow-up-booking"
            >
              {t('queue.followUp.notBooked')}
            </span>
          )}
          {f.patient.tags.map((tag) => (
            <TagChip key={tag.id} tag={tag} />
          ))}
        </p>
      </div>
      {canBook && !f.booking && (
        <div className="flex flex-wrap gap-2 lg:justify-end">
          <Link
            className={cn(buttonVariants({ size: 'sm' }), 'h-11 min-h-11 sm:h-9 sm:min-h-9')}
            href={`/clinic/appointments/new?patientId=${f.patient.id}&date=${f.followUpDate}`}
          >
            <CalendarPlus aria-hidden />
            {t('queue.followUp.book')}
          </Link>
        </div>
      )}
    </li>
  );
}
