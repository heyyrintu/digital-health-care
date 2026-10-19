'use client';

import { ApiError } from '@dhc/api-client';
import { OrganisationSettings, REFERRAL_LIMITS, type Referral } from '@dhc/contracts';
import { formatIstDateTime } from '@dhc/domain';
import { Button, Field, Surface, Textarea, buttonVariants } from '@dhc/ui-web';
import { ArrowLeft, Info } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { useSession } from '../../session-provider';
import { ClinicShell, NotAllowed } from '../../shell';
import { ReferralStatusChip, UrgencyChip, useRecipient } from '../referral-bits';

/**
 * One referral for its referring or receiving doctor. The receiving doctor's opening it
 * marks it seen; either doctor closes it with an optional note.
 */
export default function ReferralPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <ClinicShell>
      {(me) => (me.role === 'doctor' ? <ReferralScreen key={id} id={id} /> : <NotAllowed />)}
    </ClinicShell>
  );
}

const backLink = buttonVariants({
  variant: 'ghost',
  className: '-ml-3 text-muted-foreground hover:text-foreground',
});
const LABEL = 'text-xs font-bold uppercase tracking-wide text-muted-foreground';
const ALERT = 'rounded-xl bg-danger-soft px-4 py-3 text-sm font-medium text-destructive';

function ReferralScreen({ id }: { id: string }) {
  const { api, locale, signOut, t } = useSession();
  const recipient = useRecipient();
  const [referral, setReferral] = useState<Referral | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [closed, setClosed] = useState(false);
  // The chart hint is only true under "own patients only"; without the setting, no hint.
  const [ownPatients, setOwnPatients] = useState(false);

  useEffect(() => {
    let current = true;
    api
      .request('GET', '/organisation-settings', { schema: OrganisationSettings })
      .then((settings) => current && setOwnPatients(settings.chartModel === 'own_patients'))
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [api]);

  useEffect(() => {
    let current = true;
    (async () => {
      try {
        let r = await api.referral(id);
        // Opening a referral sent to you marks it seen.
        if (r.role === 'receiving' && r.status === 'sent') r = await api.markReferralSeen(id);
        if (current) setReferral(r);
      } catch (e) {
        if (!current) return;
        if (e instanceof ApiError && e.status === 401) return void signOut('expired');
        setError(e instanceof ApiError ? e.message : t('error.network'));
      }
    })();
    return () => {
      current = false;
    };
  }, [api, id, signOut, t]);

  async function close(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setReferral(await api.closeReferral(id, { note: note.trim() || null }));
      setClosed(true);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return void signOut('expired');
      setError(e instanceof ApiError ? e.message : t('error.network'));
    } finally {
      setBusy(false);
    }
  }

  const back = (
    <p>
      <Link href="/clinic/referrals" className={backLink}>
        <ArrowLeft aria-hidden />
        {t('referrals.back')}
      </Link>
    </p>
  );

  if (!referral) {
    return (
      <Surface className="space-y-3 p-5 sm:p-6">
        {back}
        {error ? (
          <p role="alert" className={ALERT}>
            {error}
          </p>
        ) : (
          <p aria-live="polite" className="text-sm text-muted-foreground">
            {t('common.loading')}
          </p>
        )}
      </Surface>
    );
  }

  const r = referral;
  const unknown = t('referrals.unknownDoctor');
  return (
    <div className="space-y-6">
      <section className="space-y-3">
        {back}
        <h1 className="font-display text-2xl font-extrabold leading-tight">
          {t('referrals.detailTitle', { name: r.patient.name })}
        </h1>
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-sm text-muted-foreground">
          <span className="tabular font-semibold text-foreground">{r.patient.uhid}</span>
          <span aria-hidden>·</span>
          <span>{t(`referrals.kind.${r.kind}`)}</span>
          <UrgencyChip urgency={r.urgency} />
          <ReferralStatusChip status={r.status} />
        </p>
        {ownPatients && r.role === 'receiving' && r.status !== 'closed' && (
          <p className="flex gap-2 rounded-xl bg-info-soft px-4 py-3 text-sm text-info">
            <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
            {t('referrals.chartHint')}
          </p>
        )}
        {closed && (
          <p role="status" className="rounded-xl bg-success-soft px-4 py-3 text-sm text-success">
            {t('referrals.closed')}
          </p>
        )}
        {error && (
          <p role="alert" className={ALERT}>
            {error}
          </p>
        )}
      </section>

      <Surface className="p-5 sm:p-6">
        <dl className="grid gap-4 sm:grid-cols-2">
          <div>
            <dt className={LABEL}>{t('referrals.referredBy')}</dt>
            <dd className="mt-1">{r.referringDoctor.name ?? unknown}</dd>
          </div>
          <div>
            <dt className={LABEL}>{t('referrals.referredTo')}</dt>
            <dd className="mt-1" data-testid="referral-recipient">
              {recipient(r)}
              {r.external?.phone && (
                <span className="tabular block text-sm text-muted-foreground">
                  {r.external.phone}
                </span>
              )}
            </dd>
          </div>
          <div className="sm:col-span-2">
            <dt className={LABEL}>{t('referrals.reason')}</dt>
            <dd className="mt-1 whitespace-pre-line" data-testid="referral-reason">
              {r.reason}
            </dd>
          </div>
          <div className="sm:col-span-2">
            <dt className={LABEL}>{t('referrals.notes')}</dt>
            <dd className="mt-1 whitespace-pre-line">{r.notes ?? t('referrals.noNotes')}</dd>
          </div>
          {r.closeNote && (
            <div className="sm:col-span-2">
              <dt className={LABEL}>{t('referrals.closeNote')}</dt>
              <dd className="mt-1 whitespace-pre-line">{r.closeNote}</dd>
            </div>
          )}
        </dl>
        <p className="mt-4 text-sm text-muted-foreground" data-testid="referral-timeline">
          {t('referrals.sentOn', { time: formatIstDateTime(r.sentAt, locale) })}
          {r.seenAt && (
            <> · {t('referrals.seenAt', { time: formatIstDateTime(r.seenAt, locale) })}</>
          )}
          {r.closedAt && (
            <>
              {' '}
              ·{' '}
              {t('referrals.closedBy', {
                time: formatIstDateTime(r.closedAt, locale),
                name: r.closedBy?.name ?? unknown,
              })}
            </>
          )}
        </p>
        <div className="mt-5 flex flex-wrap gap-2">
          <Link
            href={`/clinic/patients/${r.patient.id}`}
            className={buttonVariants({ variant: 'outline' })}
          >
            {t('referrals.openPatient')}
          </Link>
          <Link
            href={`/clinic/consultations/${r.appointmentId}`}
            className={buttonVariants({ variant: 'outline' })}
          >
            {t('referrals.openVisit')}
          </Link>
        </div>
      </Surface>

      {r.canClose && (
        <Surface className="p-5 sm:p-6">
          <form className="grid max-w-xl gap-3" onSubmit={(e) => void close(e)}>
            <Field label={t('referrals.closeNoteLabel')}>
              <Textarea
                rows={3}
                value={note}
                maxLength={REFERRAL_LIMITS.closeNote}
                onChange={(e) => setNote(e.target.value)}
              />
            </Field>
            <div>
              <Button type="submit" disabled={busy}>
                {t('referrals.close')}
              </Button>
            </div>
          </form>
        </Surface>
      )}
    </div>
  );
}
