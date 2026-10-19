'use client';

import type { ReferralStatus, ReferralSummary, ReferralUrgency } from '@dhc/contracts';
import { cn } from '@dhc/ui-web';
import { useSession } from '../session-provider';

const STATUS_LOOK: Record<ReferralStatus, string> = {
  sent: 'bg-warning-soft text-warning-foreground',
  seen: 'bg-info-soft text-info',
  closed: 'bg-muted text-muted-foreground',
};

const URGENCY_LOOK: Record<ReferralUrgency, string> = {
  routine: 'border-border text-muted-foreground',
  soon: 'border-warning text-warning-foreground',
  urgent: 'border-destructive text-destructive',
};

const PILL = 'inline-flex min-h-6 items-center rounded-full px-2.5 py-0.5 text-xs font-semibold';

/** Sent, Seen or Closed as a coloured pill. */
export function ReferralStatusChip({ status }: { status: ReferralStatus }) {
  const { t } = useSession();
  return (
    <span className={cn(PILL, STATUS_LOOK[status])} data-testid="referral-status">
      {t(`referrals.status.${status}`)}
    </span>
  );
}

/** Routine, Soon or Urgent as an outlined pill (the colour is never the only cue). */
export function UrgencyChip({ urgency }: { urgency: ReferralUrgency }) {
  const { t } = useSession();
  return (
    <span className={cn(PILL, 'border-[1.5px] bg-card', URGENCY_LOOK[urgency])}>
      {t(`referrals.urgency.${urgency}`)}
    </span>
  );
}

/** Who the referral went to: a doctor of the clinic, or the outside name and hospital. */
export function useRecipient() {
  const { t } = useSession();
  return (r: Pick<ReferralSummary, 'receivingDoctor' | 'external'>) =>
    r.receivingDoctor
      ? (r.receivingDoctor.name ?? t('referrals.unknownDoctor'))
      : [r.external?.name, r.external?.specialty, r.external?.hospital].filter(Boolean).join(', ');
}
