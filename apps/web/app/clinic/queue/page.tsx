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
    <section aria-labelledby="queue-title" className="card">
      <div className="card-header">
        <h1 id="queue-title">{t('queue.title')}</h1>
        {canRegister(me.role) && (
          <div className="header-actions">
            <Link className="button-link secondary" href="/clinic/appointments/new?walkIn=1">
              {t('appointments.walkIn')}
            </Link>
            <Link className="button-link" href={`/clinic/appointments/new?date=${date}`}>
              {t('appointments.book')}
            </Link>
          </div>
        )}
      </div>
      <p>
        <Link href="/clinic">{t('availability.back')}</Link>
      </p>

      <div className="queue-filters">
        <div>
          <label htmlFor="queue-date">{t('appointments.date')}</label>
          <input
            id="queue-date"
            type="date"
            value={date}
            onChange={(e) => e.target.value && go({ date: e.target.value, tab: undefined })}
          />
        </div>
        {doctors.length > 1 && (
          <div>
            <label htmlFor="queue-doctor">{t('availability.doctor')}</label>
            <select
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
            </select>
          </div>
        )}
        <div>
          <label htmlFor="queue-search">{t('common.search')}</label>
          <input
            id="queue-search"
            type="search"
            value={q}
            placeholder={t('queue.search')}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        {tags.length > 0 && (
          <div>
            <label htmlFor="queue-tag">{t('dashboard.filterTag')}</label>
            <select id="queue-tag" value={tagId} onChange={(e) => setTagId(e.target.value)}>
              <option value="">{t('queue.allTags')}</option>
              {tags.map((tag) => (
                <option key={tag.id} value={tag.id}>
                  {tag.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <div>
          <label htmlFor="queue-mode">{t('practice.typeMode')}</label>
          <select id="queue-mode" value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="">{t('queue.allModes')}</option>
            {MODES.map((m) => (
              <option key={m} value={m}>
                {t(`mode.${m}`)}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="queue-tabs" role="tablist" aria-label={t('queue.title')}>
        {TABS.map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            id={`tab-${key}`}
            aria-selected={tab === key}
            aria-controls="queue-panel"
            className={tab === key ? 'tab selected' : 'tab'}
            onClick={() => go({ tab: key })}
          >
            {t(`queue.tab.${key}`)} <span className="count">{queue?.[key].length ?? '–'}</span>
          </button>
        ))}
      </div>

      <div className="queue-meta hint">
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
        <button type="button" className="secondary" onClick={() => load().catch(handle)}>
          {t('queue.refresh')}
        </button>
      </div>

      {error && (
        <p role="alert" className="alert">
          {error}
        </p>
      )}
      <div id="queue-panel" role="tabpanel" aria-labelledby={`tab-${tab}`}>
        {queue && queue[tab].length === 0 && <p>{t(`queue.empty.${tab}`)}</p>}
        {rows && queue && queue[tab].length > 0 && rows.length === 0 && <p>{t('queue.noMatch')}</p>}
        {rows && rows.length > 0 && (
          <ul className="appointment-list" data-testid="appointments">
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
        )}
      </div>
    </section>
  );
}
