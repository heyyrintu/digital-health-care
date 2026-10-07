'use client';

import type { AppointmentStatus, ConsultationMode } from '@dhc/contracts';
import { Building2, Phone, Video } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';
import { cn } from '../lib/cn';
import { useT } from '../locale';

const statusClasses: Record<AppointmentStatus, string> = {
  pending: 'bg-warning-soft text-warning-foreground',
  confirmed: 'bg-info-soft text-info',
  checked_in: 'bg-accent text-accent-foreground',
  in_consultation: 'bg-primary text-primary-foreground',
  completed: 'bg-success-soft text-success',
  cancelled: 'bg-muted text-muted-foreground line-through',
  no_show: 'bg-danger-soft text-destructive',
  rescheduled: 'bg-muted text-muted-foreground',
};

/** Appointment status (PRD §5.2) as a coloured pill with its translated name. */
export function StatusChip({ status }: { status: AppointmentStatus }) {
  const t = useT();
  return (
    <span
      className={cn(
        'inline-flex min-h-6 items-center rounded-full px-2.5 py-0.5 text-xs font-semibold',
        statusClasses[status],
      )}
    >
      {t(`status.${status}`)}
    </span>
  );
}

const modeIcons = { in_person: Building2, audio: Phone, video: Video } as const;

export function ModeIcon({ mode, className }: { mode: ConsultationMode; className?: string }) {
  const Icon = modeIcons[mode];
  return <Icon className={cn('h-4 w-4', className)} aria-hidden />;
}

/** "In person", "Audio call" or "Video call" with its icon. */
export function ModeTag({ mode }: { mode: ConsultationMode }) {
  const t = useT();
  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground">
      <ModeIcon mode={mode} className="h-3.5 w-3.5" /> {t(`mode.${mode}`)}
    </span>
  );
}

/** A patient tag. The colour is a border and dot, so text contrast never depends on it. */
export function TagChip({ name, colour }: { name: string; colour: string }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border-[1.5px] border-(--tag) bg-card px-2 py-0.5 text-[11px] font-bold text-foreground"
      style={{ '--tag': colour } as CSSProperties}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-(--tag)" aria-hidden />
      {name}
    </span>
  );
}

/** A filter or choice pill; `active` fills it with the primary colour. */
export function Chip({
  children,
  active,
  className,
}: {
  children: ReactNode;
  active?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex min-h-8 items-center rounded-full border border-border/70 bg-card px-3 text-xs font-semibold',
        active && 'border-primary bg-primary text-primary-foreground',
        className,
      )}
    >
      {children}
    </span>
  );
}

const avatarTones = [
  'bg-accent text-primary',
  'bg-info-soft text-info',
  'bg-warning-soft text-warning-foreground',
  'bg-success-soft text-success',
];

/**
 * Initials in a circle. `index` picks the tone, so a list can vary them. Decorative next to
 * a visible name; pass `label` when it stands alone so screen readers get the name.
 */
export function Avatar({
  name,
  className,
  index = 0,
  label,
}: {
  name: string;
  className?: string;
  index?: number;
  label?: string;
}) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join('');
  return (
    <span
      className={cn(
        'grid h-10 w-10 shrink-0 place-items-center rounded-full text-xs font-extrabold ring-2 ring-card',
        avatarTones[index % avatarTones.length],
        className,
      )}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
    >
      {initials}
    </span>
  );
}
