'use client';

import { Inbox } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../lib/cn';
import { useT } from '../locale';

export function EmptyState({
  title,
  sub,
  icon,
}: {
  title?: ReactNode;
  sub?: ReactNode;
  icon?: ReactNode;
}) {
  const t = useT();
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed p-8 text-center">
      <span className="mb-2 text-muted-foreground" aria-hidden>
        {icon ?? <Inbox className="h-8 w-8" />}
      </span>
      <p className="font-semibold">{title ?? t('ui.empty')}</p>
      {sub && <p className="mt-1 text-sm text-muted-foreground">{sub}</p>}
    </div>
  );
}

type Tone = 'default' | 'warn' | 'danger' | 'ok';

const toneClasses: Record<Tone, string> = {
  default: 'text-primary bg-accent',
  warn: 'text-warning-foreground bg-warning-soft',
  danger: 'text-destructive bg-danger-soft',
  ok: 'text-success bg-success-soft',
};

/** A number with a label, e.g. "12 · Waiting". Clickable when `onClick` is given. */
export function Stat({
  label,
  value,
  icon,
  tone = 'default',
  onClick,
}: {
  label: ReactNode;
  value: ReactNode;
  icon?: ReactNode;
  tone?: Tone;
  onClick?: () => void;
}) {
  const body = (
    <>
      {icon && (
        <span
          className={cn(
            'grid h-10 w-10 place-items-center rounded-xl transition group-hover:scale-105',
            toneClasses[tone],
          )}
          aria-hidden
        >
          {icon}
        </span>
      )}
      <span className="min-w-0">
        <span className="tabular block font-display text-2xl font-extrabold leading-tight">
          {value}
        </span>
        <span className="mt-1 block text-xs text-muted-foreground">{label}</span>
      </span>
    </>
  );
  const classes =
    'surface group flex min-h-28 flex-col items-start justify-between gap-3 p-4 text-left font-sans text-foreground transition duration-200';
  return onClick ? (
    <button
      type="button"
      onClick={onClick}
      className={cn(classes, 'cursor-pointer hover:-translate-y-0.5 hover:shadow-lg')}
    >
      {body}
    </button>
  ) : (
    <div className={classes}>{body}</div>
  );
}
