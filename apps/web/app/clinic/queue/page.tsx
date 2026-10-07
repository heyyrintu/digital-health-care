'use client';

import { ApiError } from '@dhc/api-client';
import {
  AppointmentDetail,
  DoctorList,
  QueueResponse,
  TagList,
  type Appointment,
  type AppointmentAction,
  type ConsultationMode,
  type Doctor,
  type MeResponse,
  type Tag,
} from '@dhc/contracts';
import { istDateKey } from '@dhc/domain';
import {
  Button,
  buttonVariants,
  cn,
  EmptyState,
  Input,
  Label,
  NativeSelect,
  PageHeader,
  Surface,
} from '@dhc/ui-web';
import { CalendarPlus, RefreshCw, UserPlus } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';
import { AppointmentRow } from '../appointments/appointment-row';
import { useSession } from '../session-provider';
import { ClinicShell, canRegister } from '../shell';

const TABS = ['myOpd', 'booked', 'completed', 'closed'] as const;
type Tab = (typeof TABS)[number];
const MODES: ConsultationMode[] = ['in_person', 'video', 'audio'];

/** How often the queue refreshes while the page is visible. */
const REFRESH_MS = 15_000;

/**
 * The live queue (PRD §5.1): My OPD, Booked, Completed and Closed for a day, shared by
 * the doctor and front desk. Refreshes every 15 seconds while visible.
 */
export default function QueuePage() {
  return (
    <ClinicShell>
      {(me) =>
        me.role === 'patient' ? null : (
          <Suspense>
            <Queue me={me} />
          </Suspense>
        )
      }
    </ClinicShell>
  );
}

function Queue({ me }: { me: MeResponse }) {
  const { api, locale, signOut, t } = useSession();
  const router = useRouter();
  const params = useSearchParams();
  const today = istDateKey(new Date());
  const date = params.get('date') ?? today;
  const tab: Tab = TABS.includes(params.get('tab') as Tab)
    ? (params.get('tab') as Tab)
    : date === today
      ? 'myOpd'
      : 'booked';

  const [doctorId, setDoctorId] = useState(me.role === 'doctor' ? me.user.id : '');
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [q, setQ] = useState('');
  const [tagId, setTagId] = useState('');
  const [mode, setMode] = useState('');
  const [queue, setQueue] = useState<QueueResponse | null>(null);
  const [updated, setUpdated] = useState<Date | null>(null);
  const [now, setNow] = useState(() => new Date());
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const handle = useCallback(
    (e: unknown) => {
      if (e instanceof ApiError && e.status === 401) return void signOut('expired');
      setError(e instanceof ApiError ? e.message : t('error.network'));
    },
    [signOut, t],
  );

  const load = useCallback(async () => {
    const result = await api.request('GET', '/queue', {
      schema: QueueResponse,
      query: { date, doctorId: doctorId || undefined },
    });
    setQueue(result);
    setUpdated(new Date());
    setNow(new Date());
    setError(null);
  }, [api, date, doctorId]);

  useEffect(() => {
    setQueue(null);
    load().catch(handle);
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') load().catch(handle);
    }, REFRESH_MS);
    const tick = setInterval(() => setNow(new Date()), 30_000);
    const onVisible = () => document.visibilityState === 'visible' && load().catch(handle);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      clearInterval(tick);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load, handle]);

  useEffect(() => {
    api
      .request('GET', '/doctors', { schema: DoctorList })
      .then((d) => setDoctors(d.data))
      .catch(() => undefined);
    api
      .request('GET', '/tags', { schema: TagList })
      .then((list) => setTags(list.data.filter((tag) => !tag.archived)))
      .catch(() => undefined);
  }, [api]);

  async function act(a: Appointment, action: AppointmentAction, reason?: string) {
    setBusyId(a.id);
    try {
      await api.request('POST', `/appointments/${a.id}/actions`, {
        schema: AppointmentDetail,
        body: { action, reason: reason ?? null },
      });
      await load();
    } catch (e) {
      handle(e);
    } finally {
      setBusyId(null);
    }
  }

  const go = (next: { date?: string; tab?: Tab }) =>
    router.replace(`/clinic/queue?date=${next.date ?? date}&tab=${next.tab ?? tab}`);

  const needle = q.trim().toLowerCase();
  const matches = (a: Appointment) =>
    (!needle ||
      a.patient.name.toLowerCase().includes(needle) ||
      a.patient.uhid.toLowerCase().includes(needle) ||
      (a.patient.phone ?? '').includes(needle.replace(/\s/g, ''))) &&
    (!tagId || a.patient.tags.some((tag) => tag.id === tagId)) &&
    (!mode || a.mode === mode);
  const rows = queue ? queue[tab].filter(matches) : null;

  return (
    <section aria-labelledby="queue-title" className="space-y-5">
      <PageHeader
        titleId="queue-title"
        title={t('queue.title')}
        sub={
          <Link href="/clinic" className="underline-offset-4 hover:text-foreground hover:underline">
            {t('availability.back')}
          </Link>
        }
        actions={
          canRegister(me.role) && (
            <>
              <Link
                className={buttonVariants({ variant: 'outline' })}
                href="/clinic/appointments/new?walkIn=1"
              >
                <UserPlus aria-hidden />
                {t('appointments.walkIn')}
              </Link>
              <Link className={buttonVariants()} href={`/clinic/appointments/new?date=${date}`}>
                <CalendarPlus aria-hidden />
                {t('appointments.book')}
              </Link>
            </>
          )
        }
      />

      <Surface className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-3 sm:p-5 lg:grid-cols-5">
        <div className="space-y-2">
          <Label htmlFor="queue-date">{t('appointments.date')}</Label>
          <Input
            id="queue-date"
            type="date"
            value={date}
            onChange={(e) => e.target.value && go({ date: e.target.value, tab: undefined })}
          />
        </div>
        {doctors.length > 1 && (
          <div className="space-y-2">
            <Label htmlFor="queue-doctor">{t('availability.doctor')}</Label>
            <NativeSelect
              id="queue-doctor"
              value={doctorId}
              onChange={(e) => setDoctorId(e.target.value)}
            >
              <option value="">{t('appointments.allDoctors')}</option>
              {doctors.map((d) => (
                <option key={d.userId} value={d.userId}>
                  {d.displayName ?? d.userId}
                </option>
              ))}
            </NativeSelect>
          </div>
        )}
        <div className="col-span-2 space-y-2 sm:col-span-1">
          <Label htmlFor="queue-search">{t('common.search')}</Label>
          <Input
            id="queue-search"
            type="search"
            value={q}
            placeholder={t('queue.search')}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        {tags.length > 0 && (
          <div className="space-y-2">
            <Label htmlFor="queue-tag">{t('dashboard.filterTag')}</Label>
            <NativeSelect id="queue-tag" value={tagId} onChange={(e) => setTagId(e.target.value)}>
              <option value="">{t('queue.allTags')}</option>
              {tags.map((tag) => (
                <option key={tag.id} value={tag.id}>
                  {tag.name}
                </option>
              ))}
            </NativeSelect>
          </div>
        )}
        <div className="space-y-2">
          <Label htmlFor="queue-mode">{t('practice.typeMode')}</Label>
          <NativeSelect id="queue-mode" value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="">{t('queue.allModes')}</option>
            {MODES.map((m) => (
              <option key={m} value={m}>
                {t(`mode.${m}`)}
              </option>
            ))}
          </NativeSelect>
        </div>
      </Surface>

      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="scrollbar-none -mx-4 overflow-x-auto px-4 lg:mx-0 lg:px-0">
          <div
            className="inline-flex min-w-max gap-1 rounded-xl bg-muted p-1"
            role="tablist"
            aria-label={t('queue.title')}
          >
            {TABS.map((key) => (
              <button
                key={key}
                type="button"
                role="tab"
                id={`tab-${key}`}
                aria-selected={tab === key}
                aria-controls="queue-panel"
                className={cn(
                  'inline-flex min-h-11 cursor-pointer items-center gap-2 whitespace-nowrap rounded-lg px-3.5 text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  tab === key
                    ? 'bg-card text-foreground shadow-xs'
                    : 'text-muted-foreground hover:text-foreground',
                )}
                onClick={() => go({ tab: key })}
              >
                {t(`queue.tab.${key}`)}{' '}
                <span
                  className={cn(
                    'tabular inline-flex min-w-6 justify-center rounded-full px-1.5 py-0.5 text-xs font-bold',
                    tab === key ? 'bg-accent text-accent-foreground' : 'bg-background',
                  )}
                >
                  {queue?.[key].length ?? '–'}
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {queue?.averageConsultationMinutes != null && (
            <span data-testid="average-consult">
              {t('queue.average', { minutes: queue.averageConsultationMinutes })}
            </span>
          )}
          {updated && (
            <span>
              {t('queue.updated', {
                time: updated.toLocaleTimeString(locale === 'hi' ? 'hi-IN' : 'en-IN', {
                  hour: '2-digit',
                  minute: '2-digit',
                }),
              })}
            </span>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-11 min-h-11 sm:h-9 sm:min-h-9"
            onClick={() => load().catch(handle)}
          >
            <RefreshCw aria-hidden />
            {t('queue.refresh')}
          </Button>
        </div>
      </div>

      {error && (
        <p
          role="alert"
          className="rounded-xl bg-danger-soft p-4 text-sm font-medium text-destructive"
        >
          {error}
        </p>
      )}
      <div id="queue-panel" role="tabpanel" aria-labelledby={`tab-${tab}`}>
        {queue && queue[tab].length === 0 && <EmptyState title={t(`queue.empty.${tab}`)} />}
        {rows && queue && queue[tab].length > 0 && rows.length === 0 && (
          <EmptyState title={t('queue.noMatch')} />
        )}
        {rows && rows.length > 0 && (
          <Surface className="overflow-hidden">
            <ul className="divide-y divide-border/60" data-testid="appointments">
              {rows.map((a) => (
                <AppointmentRow
                  key={a.id}
                  a={a}
                  me={{ role: me.role, userId: me.user.id }}
                  today={today}
                  now={now}
                  busy={busyId === a.id}
                  onAct={act}
                />
              ))}
            </ul>
          </Surface>
        )}
      </div>
    </section>
  );
}
