import type { ReactNode } from 'react';
import { cn } from '../lib/cn';

/**
 * A labelled form control with a hint or an error. The label wraps the control, so the
 * control needs no id; the error is announced to screen readers.
 */
export function Field({
  label,
  children,
  error,
  hint,
}: {
  label: ReactNode;
  children: ReactNode;
  error?: string;
  hint?: ReactNode;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {hint && !error && <span className="block text-xs text-muted-foreground">{hint}</span>}
      {error && (
        <span role="alert" className="block text-xs font-medium text-destructive">
          {error}
        </span>
      )}
    </label>
  );
}

/** The browser's own select, styled like Input; best on phones and for short lists. */
export function NativeSelect({ className, ...props }: React.ComponentProps<'select'>) {
  return (
    <select
      {...props}
      className={cn(
        'h-11 w-full rounded-xl border border-input bg-card px-3 text-sm focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20 md:text-sm',
        className,
      )}
    />
  );
}
