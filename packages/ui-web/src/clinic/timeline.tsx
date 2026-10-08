'use client';

import type { AppointmentStatus } from '@dhc/contracts';
import type { ReactNode } from 'react';
import { useT } from '../locale';
import { StatusChip } from './chips';

export interface TimelineItem {
  status: AppointmentStatus;
  /** Who made the change. */
  actor: string;
  /** When, already formatted for display (IST). */
  when: ReactNode;
  note?: string;
}

/** An appointment's status history, oldest first. */
export function Timeline({ items }: { items: TimelineItem[] }) {
  const t = useT();
  return (
    <ol className="relative ml-2 border-l border-border pl-5">
      {items.map((item, i) => (
        <li key={i} className="mb-4 last:mb-0">
          <span
            className="absolute -left-[5px] mt-1.5 h-2.5 w-2.5 rounded-full bg-primary"
            aria-hidden
          />
          <div className="flex items-center gap-2">
            <StatusChip status={item.status} />
            <span className="text-xs text-muted-foreground">
              {t('ui.by', { name: item.actor })}
            </span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {item.when}
            {item.note ? ` · ${item.note}` : ''}
          </p>
        </li>
      ))}
    </ol>
  );
}
