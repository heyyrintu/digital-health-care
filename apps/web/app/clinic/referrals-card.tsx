'use client';

import { ApiError } from '@dhc/api-client';
import type { ReferralCounts } from '@dhc/contracts';
import { buttonVariants } from '@dhc/ui-web';
import { Send } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useSession } from './session-provider';

/**
 * The doctor's referrals on the dashboard (PRD §7.2): how many received referrals are new
 * (not yet opened), and how many received and sent are still open.
 */
export function ReferralsCard() {
  const { api, signOut, t } = useSession();
  const [counts, setCounts] = useState<ReferralCounts | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    api
      .referralCounts()
      .then((c) => current && setCounts(c))
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
      aria-labelledby="referrals-card-title"
      className="surface p-4 sm:p-6"
      data-testid="referrals-card"
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2
          id="referrals-card-title"
          className="flex items-center gap-2 font-display text-lg font-bold"
        >
          <Send aria-hidden className="size-5 text-primary" />
          {t('referrals.title')}
        </h2>
        {counts && counts.receivedNew > 0 && (
          <span
            className="inline-flex min-h-6 items-center rounded-full bg-warning-soft px-2.5 py-0.5 text-xs font-semibold text-warning-foreground"
            data-testid="referrals-new-count"
          >
            {t('referrals.card.new', { count: counts.receivedNew })}
          </span>
        )}
      </div>
      {error && (
        <p role="alert" className="rounded-xl bg-danger-soft px-4 py-3 text-sm text-destructive">
          {error}
        </p>
      )}
      {!counts && !error && (
        <p aria-live="polite" className="text-sm text-muted-foreground">
          {t('common.loading')}
        </p>
      )}
      {counts && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            {counts.receivedNew === 0 && <>{t('referrals.card.none')} </>}
            {t('referrals.card.summary', {
              received: counts.receivedOpen,
              sent: counts.sentOpen,
            })}
          </p>
          <Link href="/clinic/referrals" className={buttonVariants({ variant: 'outline' })}>
            {t('referrals.card.open')}
          </Link>
        </div>
      )}
    </section>
  );
}
