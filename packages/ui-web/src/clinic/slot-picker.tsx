'use client';

import type { Slot } from '@dhc/contracts';
import type { ReactNode } from 'react';
import { cn } from '../lib/cn';
import { useT, useUiLocale } from '../locale';

export interface DateChoice {
  /** `YYYY-MM-DD` (IST calendar date). */
  date: string;
  /** False when the doctor has no bookable time that day. */
  open: boolean;
}

/** A horizontal strip of days to pick from, as in the demo's booking flow. */
export function DateStrip({
  dates,
  selected,
  onSelect,
}: {
  dates: DateChoice[];
  selected?: string;
  onSelect: (date: string) => void;
}) {
  const locale = useUiLocale() === 'hi' ? 'hi-IN' : 'en-IN';
  const part = (date: string, options: Intl.DateTimeFormatOptions) =>
    new Date(`${date}T00:00:00Z`).toLocaleDateString(locale, { ...options, timeZone: 'UTC' });
  return (
    <div className="scrollbar-none -mx-4 flex gap-2 overflow-x-auto px-4 pb-2" role="group">
      {dates.map(({ date, open }) => (
        <button
          key={date}
          type="button"
          disabled={!open}
          aria-pressed={date === selected}
          aria-label={part(date, { weekday: 'long', day: 'numeric', month: 'long' })}
          onClick={() => onSelect(date)}
          className={cn(
            'flex min-h-20 w-16 shrink-0 cursor-pointer flex-col items-center justify-center rounded-2xl border py-2 text-xs transition active:scale-[.98]',
            date === selected
              ? 'border-primary bg-primary text-primary-foreground shadow-button'
              : open
                ? 'border-border/70 bg-card shadow-xs hover:border-primary'
                : 'cursor-not-allowed bg-muted text-muted-foreground opacity-45',
          )}
        >
          <span>{part(date, { weekday: 'short' })}</span>
          <span className="text-lg font-bold">{part(date, { day: 'numeric' })}</span>
          <span>{part(date, { month: 'short' })}</span>
        </button>
      ))}
    </div>
  );
}

const periods = [
  { key: 'ui.morning', from: '00:00', to: '12:00' },
  { key: 'ui.afternoon', from: '12:00', to: '17:00' },
  { key: 'ui.evening', from: '17:00', to: '24:00' },
] as const;

/**
 * One day's slots from the API, grouped into morning, afternoon and evening. The server
 * decides availability; `canChoose` lets staff pick a taken slot when overbooking.
 */
export function SlotPicker({
  slots,
  selected,
  onSelect,
  canChoose = (slot) => slot.available,
  closedMessage,
  compact,
}: {
  slots: Slot[];
  /** `start` of the chosen slot. */
  selected?: string;
  onSelect: (slot: Slot) => void;
  canChoose?: (slot: Slot) => boolean;
  /** Shown instead of the grid when the day has no slots. */
  closedMessage?: ReactNode;
  compact?: boolean;
}) {
  const t = useT();
  if (slots.length === 0) {
    return closedMessage ? (
      <p className="rounded-xl bg-muted p-4 text-center text-sm text-muted-foreground">
        {closedMessage}
      </p>
    ) : null;
  }
  return (
    <div className="space-y-5">
      {periods.map((period) => {
        const inPeriod = slots.filter((s) => s.startTime >= period.from && s.startTime < period.to);
        if (inPeriod.length === 0) return null;
        return (
          <section key={period.key} aria-label={t(period.key)}>
            <p className="mb-2 text-xs font-semibold text-muted-foreground">{t(period.key)}</p>
            <div
              className={cn('grid gap-2', compact ? 'grid-cols-3' : 'grid-cols-3 sm:grid-cols-4')}
            >
              {inPeriod.map((slot) => {
                const choosable = canChoose(slot);
                const chosen = slot.start === selected;
                const overbook = choosable && slot.unavailableReason === 'busy';
                return (
                  <button
                    key={slot.start}
                    type="button"
                    data-slot={slot.startTime}
                    disabled={!choosable}
                    aria-pressed={chosen}
                    onClick={() => onSelect(slot)}
                    className={cn(
                      'min-h-11 cursor-pointer rounded-full border px-2 py-2 text-sm font-semibold transition active:scale-[.98]',
                      chosen
                        ? 'border-primary bg-primary text-primary-foreground shadow-button'
                        : !choosable
                          ? 'cursor-not-allowed bg-muted text-muted-foreground/55 line-through'
                          : overbook
                            ? 'border-warning bg-warning-soft text-warning-foreground'
                            : 'border-border/70 bg-card hover:border-primary hover:text-primary',
                    )}
                  >
                    <span className="tabular">{slot.startTime}</span>
                    {slot.unavailableReason && (
                      <span className={overbook ? 'block text-[10px] font-medium' : 'sr-only'}>
                        {overbook ? t('book.taken') : ` (${t(`slot.${slot.unavailableReason}`)})`}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
