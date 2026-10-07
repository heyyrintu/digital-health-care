'use client';

import { ApiError } from '@dhc/api-client';
import {
  ConsultationNotes,
  ConsultationRecord,
  ConsultationView,
  PatientChart,
  type MeResponse,
} from '@dhc/contracts';
import { formatIstDateTime } from '@dhc/domain';
import { Avatar, Button, StatusChip, Surface, buttonVariants, cn } from '@dhc/ui-web';
import { ArrowLeft, Info, Lock } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AgeGender, TagChip } from '../../patient-bits';
import { useSession } from '../../session-provider';
import { ClinicShell } from '../../shell';
import { VitalsForm } from '../../vitals-form';
import { ChartPanel } from '../chart-panel';
import { NotesForm } from '../notes-form';

/** Quiet time after the last keystroke before the notes save. */
const AUTOSAVE_MS = 1200;

type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'stale' | 'error';

/** The consultation screen (PRD §6.1): patient context beside this visit's record. */
export default function ConsultationPage() {
  return <ClinicShell>{(me) => <ConsultationScreen me={me} />}</ClinicShell>;
}

function ConsultationScreen({ me }: { me: MeResponse }) {
  const { id } = useParams<{ id: string }>();
  const { api, locale, signOut, t } = useSession();
  const [view, setView] = useState<ConsultationView | null>(null);
  const [chart, setChart] = useState<PatientChart | null>(null);
  const [notes, setNotes] = useState<ConsultationNotes>(() => ConsultationNotes.parse({}));
  const [followUpDate, setFollowUpDate] = useState<string | null>(null);
  const [state, setState] = useState<SaveState>('idle');
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Autosave bookkeeping: the latest edit, the revision it builds on, and whether a
  // save is running (edits made meanwhile save straight after it).
  const latest = useRef({ notes, followUpDate });
  const revision = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const inFlight = useRef(false);
  const again = useRef(false);
  const edits = useRef(0);

  const fail = useCallback(
    (e: unknown) => {
      if (e instanceof ApiError && e.status === 401) return void signOut('expired');
      setError(e instanceof ApiError ? e.message : t('error.network'));
    },
    [signOut, t],
  );

  const load = useCallback(async () => {
    setError(null);
    try {
      const v = await api.request('GET', `/appointments/${encodeURIComponent(id)}/consultation`, {
        schema: ConsultationView,
      });
      setView(v);
      const n = v.consultation?.notes ?? ConsultationNotes.parse({});
      const f = v.consultation?.followUpDate ?? null;
      setNotes(n);
      setFollowUpDate(f);
      latest.current = { notes: n, followUpDate: f };
      revision.current = v.consultation?.revision ?? 0;
      setSavedAt(v.consultation?.updatedAt ?? null);
      setState(v.consultation ? 'saved' : 'idle');
      setChart(
        await api.request('GET', `/patients/${v.appointment.patient.id}/chart`, {
          schema: PatientChart,
        }),
      );
    } catch (e) {
      fail(e);
    }
  }, [api, id, fail]);

  useEffect(() => {
    void load();
    return () => clearTimeout(timer.current);
  }, [load]);

  const save = useCallback(async () => {
    if (inFlight.current) {
      again.current = true;
      return;
    }
    inFlight.current = true;
    setState('saving');
    const { notes: n, followUpDate: f } = latest.current;
    const editsAtStart = edits.current;
    try {
      const record = await api.request('PUT', `/appointments/${id}/consultation`, {
        schema: ConsultationRecord,
        body: {
          // Blank symptom rows are still being typed; they are not part of the record.
          notes: { ...n, symptoms: n.symptoms.filter((s) => s.text.trim()) },
          followUpDate: f,
          revision: revision.current,
        },
      });
      revision.current = record.revision;
      setSavedAt(record.updatedAt);
      setError(null);
      setState(edits.current === editsAtStart ? 'saved' : 'dirty');
    } catch (e) {
      again.current = false;
      if (e instanceof ApiError && e.status === 409 && e.fields.revision === 'stale') {
        setState('stale');
      } else {
        setState('error');
        fail(e);
      }
    } finally {
      inFlight.current = false;
      if (again.current) {
        again.current = false;
        void save();
      }
    }
  }, [api, id, fail]);

  const edit = (n: ConsultationNotes, f: string | null) => {
    setNotes(n);
    setFollowUpDate(f);
    latest.current = { notes: n, followUpDate: f };
    edits.current += 1;
    setState('dirty');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(), AUTOSAVE_MS);
  };

  // Warn before leaving with unsaved notes.
  useEffect(() => {
    if (state !== 'dirty' && state !== 'saving') return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [state]);

  if (!view) {
    return (
      <Surface className="space-y-3 p-5 sm:p-6">
        <p>
          <Link href="/clinic/queue" className={backLink}>
            <ArrowLeft aria-hidden />
            {t('consult.back')}
          </Link>
        </p>
        {error ? (
          <p role="alert" className={alertBox}>
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

  const { appointment: a } = view;
  const editable = view.canEdit && state !== 'stale';
  const locked = Boolean(view.consultation?.lockedAt);

  return (
    <div className="space-y-6">
      <section className="space-y-4">
        <p>
          <Link href={`/clinic/queue?date=${a.date}`} className={backLink}>
            <ArrowLeft aria-hidden />
            {t('consult.back')}
          </Link>
        </p>
        <div className="flex items-start gap-3 sm:gap-4">
          <Avatar name={a.patient.name} className="h-12 w-12 text-sm sm:h-14 sm:w-14" />
          <div className="min-w-0 flex-1">
            <h1 className="font-display text-2xl font-extrabold leading-tight">
              {t('consult.title')}: {a.patient.name}
            </h1>
            <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-sm text-muted-foreground">
              <span className="tabular font-semibold text-foreground">{a.patient.uhid}</span>
              <span aria-hidden>·</span>
              <span>
                <AgeGender patient={a.patient} />
              </span>
              <span aria-hidden>·</span>
              <span className="tabular">
                {a.date} {a.source === 'walk_in' ? t('appointments.walkInBadge') : a.startTime}
              </span>
              <span data-testid="appointment-status">
                <StatusChip status={a.status} />
              </span>
              {a.patient.tags.map((tag) => (
                <TagChip key={tag.id} tag={tag} />
              ))}
            </p>
          </div>
        </div>
        {locked ? (
          <p className={noticeBox}>
            <Lock aria-hidden className="mt-0.5 size-4 shrink-0" />
            {t('consult.locked')}
          </p>
        ) : (
          !view.canEdit && (
            <p className={noticeBox}>
              <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
              {t('consult.readOnly')}
            </p>
          )
        )}
        {state === 'stale' && (
          <p role="alert" className={cn(alertBox, 'flex flex-wrap items-center gap-x-2')}>
            {t('consult.stale')}{' '}
            <Button type="button" variant="link" className="px-1" onClick={() => void load()}>
              {t('consult.reload')}
            </Button>
          </p>
        )}
        {error && state !== 'stale' && (
          <p role="alert" className={alertBox}>
            {error}
          </p>
        )}
      </section>

      <div className="grid gap-6 lg:grid-cols-[minmax(300px,380px)_minmax(0,1fr)] lg:items-start">
        <aside className="surface min-w-0 p-5 sm:p-6 lg:sticky lg:top-20">
          <h2 className="font-display text-lg font-bold">{t('chart.title')}</h2>
          {chart ? (
            <ChartPanel chart={chart} editable={me.role === 'doctor'} onChange={setChart} />
          ) : (
            <p aria-live="polite" className="mt-3 text-sm text-muted-foreground">
              {t('common.loading')}
            </p>
          )}
        </aside>

        <div className="grid min-w-0 content-start gap-6">
          <Surface className="p-5 sm:p-6">
            <section>
              <h2 className="mb-4 font-display text-lg font-bold">{t('vitals.title')}</h2>
              <VitalsForm
                appointmentId={a.id}
                vitals={view.vitals}
                patient={a.patient}
                editable={!locked && !['cancelled', 'no_show', 'rescheduled'].includes(a.status)}
              />
            </section>
          </Surface>
          <Surface className="p-5 sm:p-6">
            <section>
              <div className="mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
                <h2 className="font-display text-lg font-bold">{t('consult.title')}</h2>
                <SaveStatus state={state} savedAt={savedAt} locale={locale} />
              </div>
              <NotesForm
                notes={notes}
                followUpDate={followUpDate}
                patientId={a.patient.id}
                editable={editable}
                onChange={edit}
              />
            </section>
          </Surface>
        </div>
      </div>
    </div>
  );
}

const backLink = buttonVariants({
  variant: 'ghost',
  className: '-ml-3 text-muted-foreground hover:text-foreground',
});
const alertBox = 'rounded-xl bg-danger-soft px-4 py-3 text-sm font-medium text-destructive';
const noticeBox = 'flex gap-2 rounded-xl bg-info-soft px-4 py-3 text-sm text-info';

function SaveStatus({
  state,
  savedAt,
  locale,
}: {
  state: SaveState;
  savedAt: string | null;
  locale: 'en' | 'hi';
}) {
  const { t } = useSession();
  const text =
    state === 'saving'
      ? t('consult.saving')
      : state === 'dirty' || state === 'error'
        ? t('consult.unsaved')
        : state === 'saved' && savedAt
          ? t('consult.saved', { time: formatIstDateTime(savedAt, locale) })
          : '';
  return (
    <p
      role="status"
      aria-live="polite"
      data-testid="save-status"
      className={cn(
        'inline-flex min-h-6 items-center gap-1.5 whitespace-nowrap text-xs font-medium text-muted-foreground',
        state === 'error' && 'text-destructive',
      )}
    >
      {text && (
        <span
          aria-hidden
          className={cn(
            'size-2 rounded-full',
            state === 'saved' ? 'bg-success' : state === 'error' ? 'bg-destructive' : 'bg-warning',
          )}
        />
      )}
      {text}
    </p>
  );
}
