'use client';

import { ApiError } from '@dhc/api-client';
import type { AwaitingReviewList } from '@dhc/contracts';
import { formatIstDateTime, testOrderLabel } from '@dhc/domain';
import { FlaskConical } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useSession } from './session-provider';

/**
 * The doctor's in-app notification for test results (PRD §7.1): results uploaded against
 * their orders and not yet reviewed, oldest first, each linking to the patient's profile
 * where it is opened and marked reviewed.
 */
export function ResultsAwaiting() {
  const { api, locale, signOut, t } = useSession();
  const [list, setList] = useState<AwaitingReviewList | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setError(null);
    api
      .testResultsAwaitingReview()
      .then((l) => current && setList(l))
      .catch((e: unknown) => {
        if (!current) return;
        if (e instanceof ApiError && e.status === 401) return void signOut('expired');
        setError(e instanceof ApiError ? e.message : t('error.network'));
      });
    return () => {
      current = false;
    };
  }, [api, signOut, t]);

  return (
    <section
      aria-labelledby="awaiting-title"
      className="surface p-4 sm:p-6"
      data-testid="results-awaiting"
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 id="awaiting-title" className="flex items-center gap-2 font-display text-lg font-bold">
          <FlaskConical aria-hidden className="size-5 text-primary" />
          {t('orders.awaiting.title')}
        </h2>
        {list && list.count > 0 && (
          <span
            className="inline-flex min-h-6 items-center rounded-full bg-warning-soft px-2.5 py-0.5 text-xs font-semibold text-warning-foreground"
            data-testid="results-awaiting-count"
          >
            {t('orders.awaiting.count', { count: list.count })}
          </span>
        )}
      </div>
      {error && (
        <p role="alert" className="rounded-xl bg-danger-soft px-4 py-3 text-sm text-destructive">
          {error}
        </p>
      )}
      {!list && !error && (
        <p aria-live="polite" className="text-sm text-muted-foreground">
          {t('common.loading')}
        </p>
      )}
      {list?.count === 0 && (
        <p className="text-sm text-muted-foreground">{t('orders.awaiting.none')}</p>
      )}
      {list && list.data.length > 0 && (
        <ul className="m-0 grid list-none gap-2 p-0">
          {list.data.map((r) => (
            <li
              key={r.id}
              className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-xl border border-border px-3 py-2"
            >
              <span className="min-w-0">
                <Link
                  href={`/clinic/patients/${r.patient.id}`}
                  className="font-semibold text-primary hover:underline"
                >
                  {r.patient.name}
                </Link>{' '}
                <span className="tabular text-sm text-muted-foreground">· {r.patient.uhid}</span>{' '}
                <span className="text-sm">· {testOrderLabel(r, locale)}</span>
              </span>
              <span className="text-xs text-muted-foreground">
                {t('orders.awaiting.uploaded', {
                  time: formatIstDateTime(r.resultUploadedAt, locale),
                })}
              </span>
            </li>
          ))}
        </ul>
      )}
      {list && list.count > list.data.length && (
        <p className="mt-2 text-sm text-muted-foreground">
          {t('orders.awaiting.more', { count: list.count - list.data.length })}
        </p>
      )}
    </section>
  );
}
