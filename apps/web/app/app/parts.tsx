'use client';

import type { PortalPatient } from '@dhc/contracts';
import { Button, cn } from '@dhc/ui-web';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { consentRequired, portalErrorMessage } from '../../lib/patient';
import { CLICKED_URL_TTL_MS } from '../../lib/patient-files';
import { usePatientSession } from './session-provider';

/** A page's title and its content, in the portal's narrow, phone-first column. */
export function PortalPage({
  title,
  intro,
  children,
}: {
  title: string;
  intro?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby="page-title" className="space-y-5">
      <div>
        <h1 id="page-title" className="font-display text-2xl font-extrabold">
          {title}
        </h1>
        {intro && <p className="mt-1.5 text-sm text-muted-foreground">{intro}</p>}
      </div>
      {children}
    </section>
  );
}

export function Loading() {
  const { t } = usePatientSession();
  return (
    <p aria-live="polite" className="py-6 text-center text-sm text-muted-foreground">
      {t('common.loading')}
    </p>
  );
}

/** A success or error message, announced to screen readers. */
export function Notice({
  tone,
  children,
}: {
  tone: 'success' | 'error' | 'info';
  children: ReactNode;
}) {
  return (
    <p
      role={tone === 'error' ? 'alert' : 'status'}
      className={cn(
        'rounded-xl px-4 py-3 text-sm font-medium',
        tone === 'error' && 'bg-danger-soft text-destructive',
        tone === 'success' && 'bg-success-soft text-success',
        tone === 'info' && 'bg-info-soft text-foreground',
      )}
    >
      {children}
    </p>
  );
}

/** An error with a retry; a consent withdrawn elsewhere sends the person back to onboarding. */
export function LoadError({ error, retry }: { error: unknown; retry: () => void }) {
  const { account, t } = usePatientSession();
  const consentGone = consentRequired(error);
  useEffect(() => {
    if (consentGone) void account.reload();
  }, [consentGone, account]);
  return (
    <div className="space-y-3">
      <Notice tone="error">{portalErrorMessage(error, t)}</Notice>
      <Button type="button" variant="outline" onClick={retry}>
        {t('common.retry')}
      </Button>
    </div>
  );
}

/** A labelled, wrapping row of toggle buttons; one is chosen at a time. */
export function ChoiceGroup<T extends string>({
  label,
  options,
  value,
  onChange,
  error,
}: {
  label: string;
  options: { value: T; label: string }[];
  value: T | null;
  onChange: (value: T) => void;
  error?: string;
}) {
  const id = useId();
  return (
    <div
      role="group"
      aria-labelledby={`${id}-label`}
      aria-describedby={error ? `${id}-error` : undefined}
      className="space-y-2"
    >
      <p id={`${id}-label`} className="text-sm font-medium">
        {label}
      </p>
      <div className="flex flex-wrap gap-2">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            aria-pressed={o.value === value}
            onClick={() => onChange(o.value)}
            className={cn(
              'min-h-11 cursor-pointer rounded-full border px-4 py-2 text-sm font-semibold transition active:scale-[.98]',
              o.value === value
                ? 'border-primary bg-primary text-primary-foreground shadow-button'
                : 'border-border/70 bg-card hover:border-primary hover:text-primary',
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
      {error && (
        <p id={`${id}-error`} role="alert" className="text-xs font-medium text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/** Picks one of the family; hidden when there is only one. */
export function PatientPicker({
  label,
  patients,
  selectedId,
  onSelect,
}: {
  label: string;
  patients: PortalPatient[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  if (patients.length < 2) return null;
  return (
    <ChoiceGroup
      label={label}
      options={patients.map((p) => ({ value: p.id, label: p.name }))}
      value={selectedId}
      onChange={onSelect}
    />
  );
}

/**
 * The browser blocked the file's new tab: a link the person clicks to download it (nothing
 * is saved unasked). Its object URL is revoked just after the click, when the link goes
 * away (another action, sign-out) or when its time is up, whichever is first.
 */
export function BlockedDownload({ url, name }: { url: string; name: string }) {
  const { files, t } = usePatientSession();
  const [gone, setGone] = useState(false);
  useEffect(() => () => files.release(url), [files, url]);
  if (gone) return null;
  return (
    <p role="status" className="rounded-xl bg-info-soft px-4 py-3 text-sm font-medium">
      <a
        href={url}
        download={name}
        className="font-semibold text-primary underline underline-offset-2"
        onClick={() =>
          files.deps.later(() => {
            files.release(url);
            setGone(true);
          }, CLICKED_URL_TTL_MS)
        }
      >
        {t('portal.files.blocked')}
      </a>
    </p>
  );
}
