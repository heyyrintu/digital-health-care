import type { ReactNode } from 'react';
import { cn } from '../lib/cn';

/** Page title with an optional subtitle and actions (right-aligned from `sm`). */
export function PageHeader({
  title,
  titleId,
  sub,
  actions,
}: {
  title: ReactNode;
  /** id for the h1, so a section can point `aria-labelledby` at it. */
  titleId?: string;
  sub?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:mb-7 sm:flex-row sm:flex-wrap sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h1 id={titleId} className="font-display text-2xl font-extrabold sm:truncate">
          {title}
        </h1>
        {sub && <p className="mt-1.5 text-sm text-muted-foreground">{sub}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2 sm:shrink-0 sm:justify-end">{actions}</div>}
    </div>
  );
}

/** The demo's card surface: white, softly rounded, soft shadow. */
export function Surface({ children, className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('surface', className)} {...props}>
      {children}
    </div>
  );
}

/** Small uppercase heading above a group of controls. */
export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <p className="mb-2 mt-4 text-[11px] font-bold uppercase tracking-wide text-muted-foreground first:mt-0">
      {children}
    </p>
  );
}
