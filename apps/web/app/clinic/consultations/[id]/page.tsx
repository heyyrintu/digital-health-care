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
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AgeGender, TagChip } from '../../patient-bits';
import { useSession } from '../../session-provider';
import { ClinicShell } from '../../shell';
import { VitalsForm } from '../../vitals-form';
import { ChartPanel } from '../chart-panel';
import { NotesForm } from '../notes-form';
import { PrescriptionCard } from '../prescription-card';

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

  // Kept in refs so switching the clinic language never re-runs the load (which would
  // drop unsaved notes).
  const session = useRef({ signOut, t });
  useEffect(() => {
    session.current = { signOut, t };
  }, [signOut, t]);
  const fail = useCallback((e: unknown) => {
    if (e instanceof ApiError && e.status === 401) return void session.current.signOut('expired');
    setError(e instanceof ApiError ? e.message : session.current.t('error.network'));
  }, []);

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
    timer.current = setTimeout(() => {
      timer.current = undefined;
      void save();
    }, AUTOSAVE_MS);
  };

  // Leaving the screen (e.g. back to the queue) saves notes still waiting for the timer.
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  }, [save]);
  useEffect(
    () => () => {
      if (timer.current === undefined) return;
      clearTimeout(timer.current);
      void saveRef.current();
    },
    [],
  );

  // Warn before leaving with unsaved notes.
  useEffect(() => {
    if (state !== 'dirty' && state !== 'saving') return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [state]);

  if (!view) {
    return (
      <section className="card">
        <p>
          <Link href="/clinic/queue">{t('consult.back')}</Link>
        </p>
        {error ? (
          <p role="alert" className="alert">
            {error}
          </p>
        ) : (
          <p aria-live="polite">{t('common.loading')}</p>
        )}
      </section>
    );
  }

  const { appointment: a } = view;
  const editable = view.canEdit && state !== 'stale';
  const locked = Boolean(view.consultation?.lockedAt);

  return (
    <div className="consult">
      <section className="card consult-header">
        <p>
          <Link href={`/clinic/queue?date=${a.date}`}>{t('consult.back')}</Link>
        </p>
        <div className="card-header">
          <h1>
            {t('consult.title')}: {a.patient.name}
          </h1>
          <SaveStatus state={state} savedAt={savedAt} locale={locale} />
        </div>
        <p className="patient-meta">
          {a.patient.uhid} · <AgeGender patient={a.patient} /> · {a.date}{' '}
          {a.source === 'walk_in' ? t('appointments.walkInBadge') : a.startTime} ·{' '}
          <span className="pill" data-testid="appointment-status">
            {t(`status.${a.status}`)}
          </span>
          {a.patient.tags.map((tag) => (
            <TagChip key={tag.id} tag={tag} />
          ))}
        </p>
        {locked ? (
          <p className="notice">{t('consult.locked')}</p>
        ) : (
          !view.canEdit && <p className="notice">{t('consult.readOnly')}</p>
        )}
        {state === 'stale' && (
          <p role="alert" className="alert">
            {t('consult.stale')}{' '}
            <button type="button" className="link-button" onClick={() => void load()}>
              {t('consult.reload')}
            </button>
          </p>
        )}
        {error && state !== 'stale' && (
          <p role="alert" className="alert">
            {error}
          </p>
        )}
      </section>

      <div className="consult-body">
        <aside className="card consult-context">
          <h2>{t('chart.title')}</h2>
          {chart ? (
            <ChartPanel chart={chart} editable={me.role === 'doctor'} onChange={setChart} />
          ) : (
            <p aria-live="polite">{t('common.loading')}</p>
          )}
        </aside>

        <div className="consult-main">
          <section className="card">
            <h2>{t('vitals.title')}</h2>
            <VitalsForm
              appointmentId={a.id}
              vitals={view.vitals}
              patient={a.patient}
              editable={!locked && !['cancelled', 'no_show', 'rescheduled'].includes(a.status)}
            />
          </section>
          <section className="card">
            <h2>{t('consult.title')}</h2>
            <NotesForm
              notes={notes}
              followUpDate={followUpDate}
              patientId={a.patient.id}
              editable={editable}
              onChange={edit}
            />
          </section>
          <section className="card" data-testid="prescription">
            <PrescriptionCard appointmentId={a.id} patientId={a.patient.id} />
          </section>
        </div>
      </div>
    </div>
  );
}

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
    <p className="hint save-status" aria-live="polite" data-testid="save-status">
      {text}
    </p>
  );
}
