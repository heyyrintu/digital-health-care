'use client';

import { ApiError } from '@dhc/api-client';
import type { PlatformDoctor, VerifiedPlatformDoctor } from '@dhc/contracts';
import { formatIstDateTime } from '@dhc/domain';
import {
  Button,
  Input,
  PageHeader,
  Surface,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@dhc/ui-web';
import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import {
  appendPage,
  isTicket,
  platformErrorKey,
  verifiable,
  verifyBody,
  verifyConflict,
} from '../../../lib/platform';
import { usePlatformSession } from '../session-provider';
import { ErrorNotice, PlatformShell } from '../shell';

type Queue = 'pending' | 'verified';

/** The doctor verification queue across organisations, oldest first (PRD §9.1 step 4). */
export default function DoctorsPage() {
  return <PlatformShell>{() => <DoctorsScreen />}</PlatformShell>;
}

function DoctorsScreen() {
  const { t } = usePlatformSession();
  return (
    <section className="space-y-5">
      <PageHeader title={t('platform.doctors.title')} sub={t('platform.doctors.sub')} />
      <Tabs defaultValue="pending">
        <TabsList>
          <TabsTrigger value="pending">{t('platform.doctors.tabPending')}</TabsTrigger>
          <TabsTrigger value="verified">{t('platform.doctors.tabVerified')}</TabsTrigger>
        </TabsList>
        <TabsContent value="pending">
          <DoctorQueue status="pending" />
        </TabsContent>
        <TabsContent value="verified">
          <DoctorQueue status="verified" />
        </TabsContent>
      </Tabs>
    </section>
  );
}

function DoctorQueue({ status }: { status: Queue }) {
  const { api, locale, signOut, t } = usePlatformSession();
  const [rows, setRows] = useState<PlatformDoctor[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const fail = useCallback(
    (e: unknown) => {
      if (e instanceof ApiError && e.status === 401) return void signOut('expired');
      const key = platformErrorKey(e, 'page');
      setError(key ? t(key) : (e as Error).message);
    },
    [signOut, t],
  );

  const load = useCallback(async () => {
    setError(null);
    setOpen(null);
    try {
      const page = await api.platform.doctors(status);
      setRows(page.data);
      setNextCursor(page.nextCursor);
    } catch (e) {
      fail(e);
    }
  }, [api, status, fail]);

  useEffect(() => {
    void load();
  }, [load]);

  async function loadMore() {
    if (!nextCursor) return;
    setBusy(true);
    try {
      const page = await api.platform.doctors(status, nextCursor);
      setRows((shown) => appendPage(shown ?? [], page.data));
      setNextCursor(page.nextCursor);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  const nameOf = (d: PlatformDoctor) => d.displayName ?? t('platform.doctors.unnamed');

  function verified(result: VerifiedPlatformDoctor | { verifiedMeanwhile: PlatformDoctor }) {
    const doctor = 'verifiedMeanwhile' in result ? result.verifiedMeanwhile : result;
    setRows((shown) => (shown ?? []).filter((d) => d.profileId !== doctor.profileId));
    setOpen(null);
    setNotice(
      'verifiedMeanwhile' in result
        ? t('platform.doctors.verifiedMeanwhile')
        : result.alreadyVerified
          ? t('platform.doctors.alreadyVerified', { name: nameOf(doctor) })
          : t('platform.doctors.verified', { name: nameOf(doctor) }),
    );
  }

  return (
    <Surface className="mt-4 min-w-0 space-y-4 p-4 sm:p-6">
      {notice && (
        <p role="status" className="rounded-xl bg-success-soft px-4 py-3 text-sm">
          {notice}
        </p>
      )}
      <ErrorNotice message={error} />
      {!rows ? (
        !error && (
          <p aria-live="polite" className="text-sm text-muted-foreground">
            {t('common.loading')}
          </p>
        )
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {status === 'pending'
            ? t('platform.doctors.emptyPending')
            : t('platform.doctors.emptyVerified')}
        </p>
      ) : (
        <ul className="divide-y divide-border/70" data-testid={`doctors-${status}`}>
          {rows.map((d) => (
            <li key={d.profileId} data-testid={`doctor-${d.profileId}`} className="py-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <h3 className="font-display text-base font-bold">{nameOf(d)}</h3>
                  <p className="text-sm text-muted-foreground">
                    {d.identifier} · {d.organisation.name}{' '}
                    <span className="text-xs">({d.organisation.slug})</span>
                  </p>
                  <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
                    <Detail
                      label={t('platform.doctors.registration')}
                      value={d.registrationNumber}
                    />
                    <Detail label={t('platform.doctors.council')} value={d.council} />
                    <Detail label={t('platform.doctors.qualifications')} value={d.qualifications} />
                    <Detail label={t('platform.doctors.specialty')} value={d.specialty} />
                  </dl>
                  <p className="text-xs text-muted-foreground">
                    {t('platform.doctors.submitted', {
                      date: formatIstDateTime(d.submittedAt, locale),
                    })}
                    {d.verifiedAt &&
                      ` · ${t('platform.doctors.verifiedOn', {
                        date: formatIstDateTime(d.verifiedAt, locale),
                        by: d.verifiedBy ?? '—',
                      })}`}
                  </p>
                </div>
                {status === 'pending' && open !== d.profileId && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setNotice(null);
                      setOpen(d.profileId);
                    }}
                  >
                    {t('platform.doctors.verify')}
                  </Button>
                )}
              </div>
              {status === 'pending' && open === d.profileId && (
                <VerifyPanel
                  doctor={d}
                  onVerified={verified}
                  onCancel={() => setOpen(null)}
                  onReload={() => void load()}
                />
              )}
            </li>
          ))}
        </ul>
      )}
      {nextCursor && (
        <Button type="button" variant="outline" disabled={busy} onClick={() => void loadMore()}>
          {t('platform.doctors.more')}
        </Button>
      )}
    </Surface>
  );
}

function Detail({ label, value }: { label: string; value: string | null }) {
  const { t } = usePlatformSession();
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium">{value ?? t('platform.doctors.notGiven')}</dd>
    </>
  );
}

/**
 * Verifying one doctor: the ticket that records the check, and a confirmation that the
 * details shown were checked. Sends `expected` exactly as shown; a profile changed since
 * is refused and the queue must be reloaded.
 */
function VerifyPanel({
  doctor,
  onVerified,
  onCancel,
  onReload,
}: {
  doctor: PlatformDoctor;
  onVerified: (result: VerifiedPlatformDoctor | { verifiedMeanwhile: PlatformDoctor }) => void;
  onCancel: () => void;
  onReload: () => void;
}) {
  const { api, signOut, t } = usePlatformSession();
  const id = useId();
  const [ticket, setTicket] = useState('');
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (!isTicket(ticket.trim())) return setError(t('platform.doctors.ticketInvalid'));
    if (!checked) return setError(t('platform.doctors.confirmNeeded'));
    const body = verifyBody(doctor, ticket);
    if (!body) return setError(t('platform.doctors.incomplete'));
    setBusy(true);
    try {
      onVerified(await api.platform.verifyDoctor(doctor.profileId, body));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return void signOut('expired');
      const conflict = verifyConflict(e);
      if (conflict === 'verified') return onVerified({ verifiedMeanwhile: doctor });
      if (conflict === 'changed' || (e instanceof ApiError && e.status === 404)) setChanged(true);
      const key = conflict === 'changed' ? 'platform.doctors.changed' : platformErrorKey(e, 'page');
      setError(key ? t(key) : (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!verifiable(doctor)) {
    return (
      <p className="mt-3 rounded-xl bg-warning-soft p-4 text-sm text-warning-foreground">
        {t('platform.doctors.incomplete')}
      </p>
    );
  }

  return (
    <form
      className="mt-3 space-y-3 rounded-xl bg-warning-soft p-4 text-sm text-warning-foreground"
      aria-label={t('platform.doctors.verifyDo')}
      onSubmit={(e) => void submit(e)}
      noValidate
    >
      <div className="max-w-xs space-y-1.5">
        <label className="block text-sm font-medium" htmlFor={`${id}-ticket`}>
          {t('platform.doctors.ticket')}
        </label>
        <Input
          id={`${id}-ticket`}
          name="ticket"
          autoComplete="off"
          autoFocus
          value={ticket}
          onChange={(e) => setTicket(e.target.value)}
          aria-describedby={`${id}-ticket-hint`}
        />
        <p id={`${id}-ticket-hint`} className="text-xs">
          {t('platform.doctors.ticketHint')}
        </p>
      </div>
      <label className="flex min-h-11 items-start gap-2">
        <input
          type="checkbox"
          name="checked"
          checked={checked}
          onChange={(e) => setChecked(e.target.checked)}
          className="mt-1 size-4 shrink-0 accent-primary"
        />
        <span>{t('platform.doctors.confirm')}</span>
      </label>
      <ErrorNotice message={error} />
      <div className="flex flex-wrap gap-3">
        {changed ? (
          <Button type="button" onClick={onReload}>
            {t('platform.doctors.reload')}
          </Button>
        ) : (
          <Button type="submit" disabled={busy}>
            {t('platform.doctors.verifyDo')}
          </Button>
        )}
        <Button type="button" variant="outline" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  );
}
