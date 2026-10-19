'use client';

import { ApiError } from '@dhc/api-client';
import type { ReferralSummary } from '@dhc/contracts';
import { formatIstDateTime } from '@dhc/domain';
import { Button, PageHeader, Surface, Tabs, TabsContent, TabsList, TabsTrigger } from '@dhc/ui-web';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useSession } from '../session-provider';
import { ClinicShell, NotAllowed } from '../shell';
import { ReferralStatusChip, UrgencyChip, useRecipient } from './referral-bits';

type Box = 'received' | 'sent';

/** The doctor's referrals (PRD §7.2): those received and those sent, newest first. */
export default function ReferralsPage() {
  return (
    <ClinicShell>
      {(me) => (me.role === 'doctor' ? <ReferralsScreen /> : <NotAllowed />)}
    </ClinicShell>
  );
}

function ReferralsScreen() {
  const { t } = useSession();
  return (
    <div>
      <PageHeader titleId="referrals-title" title={t('referrals.title')} sub={t('referrals.sub')} />
      <Tabs defaultValue="received">
        <TabsList>
          <TabsTrigger value="received">{t('referrals.tabReceived')}</TabsTrigger>
          <TabsTrigger value="sent">{t('referrals.tabSent')}</TabsTrigger>
        </TabsList>
        <TabsContent value="received">
          <ReferralBox box="received" />
        </TabsContent>
        <TabsContent value="sent">
          <ReferralBox box="sent" />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function ReferralBox({ box }: { box: Box }) {
  const { api, locale, signOut, t } = useSession();
  const recipient = useRecipient();
  const [rows, setRows] = useState<ReferralSummary[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (cursor?: string) => {
      setBusy(true);
      try {
        const page = await api.referrals({ box, cursor });
        setRows((current) => (cursor ? [...(current ?? []), ...page.data] : page.data));
        setNextCursor(page.nextCursor);
        setError(null);
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return void signOut('expired');
        setError(e instanceof ApiError ? e.message : t('error.network'));
      } finally {
        setBusy(false);
      }
    },
    [api, box, signOut, t],
  );

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Surface className="mt-4 p-4 sm:p-6" data-testid={`referrals-${box}`}>
      {error && (
        <p role="alert" className="rounded-xl bg-danger-soft px-4 py-3 text-sm text-destructive">
          {error}
        </p>
      )}
      {!rows && !error && (
        <p aria-live="polite" className="text-sm text-muted-foreground">
          {t('common.loading')}
        </p>
      )}
      {rows?.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {t(box === 'received' ? 'referrals.noneReceived' : 'referrals.noneSent')}
        </p>
      )}
      {rows && rows.length > 0 && (
        <ul className="m-0 grid list-none gap-2 p-0">
          {rows.map((r) => (
            <li
              key={r.id}
              className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 rounded-xl border border-border px-3 py-2.5"
              data-testid={`referral-${r.id}`}
            >
              <span className="min-w-0">
                <Link
                  href={`/clinic/referrals/${r.id}`}
                  aria-label={t('referrals.openFor', { name: r.patient.name })}
                  className="font-semibold text-primary hover:underline"
                >
                  {r.patient.name}
                </Link>{' '}
                <span className="tabular text-sm text-muted-foreground">· {r.patient.uhid}</span>
                <span className="block text-sm">
                  {box === 'received'
                    ? t('referrals.from', {
                        name: r.referringDoctor.name ?? t('referrals.unknownDoctor'),
                      })
                    : t('referrals.to', { name: recipient(r) })}
                  <span className="text-xs text-muted-foreground">
                    {' '}
                    · {t('referrals.sentOn', { time: formatIstDateTime(r.sentAt, locale) })}
                  </span>
                </span>
              </span>
              <span className="flex flex-wrap items-center gap-1.5">
                <UrgencyChip urgency={r.urgency} />
                <ReferralStatusChip status={r.status} />
              </span>
            </li>
          ))}
        </ul>
      )}
      {nextCursor && (
        <Button
          type="button"
          variant="outline"
          className="mt-3"
          disabled={busy}
          onClick={() => void load(nextCursor)}
        >
          {t('referrals.loadMore')}
        </Button>
      )}
    </Surface>
  );
}
