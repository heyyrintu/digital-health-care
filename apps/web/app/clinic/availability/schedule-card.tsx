'use client';

import { ApiError } from '@dhc/api-client';
import { AvailabilityVersion, AvailabilityVersionList, type WeeklySchedule } from '@dhc/contracts';
import { addDays, type Weekday } from '@dhc/domain';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useSession } from '../session-provider';
import type { Selection } from './selection';

/** Clinic week order (the domain's WEEKDAYS starts on Sunday). */
const WEEK: Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

type Draft = Record<Weekday, { start: string; end: string }[]>;

const toDraft = (weekly: WeeklySchedule | undefined): Draft =>
  Object.fromEntries(WEEK.map((d) => [d, [...(weekly?.[d] ?? [])]])) as Draft;

const fromDraft = (draft: Draft): WeeklySchedule =>
  Object.fromEntries(WEEK.filter((d) => draft[d].length > 0).map((d) => [d, draft[d]]));

/** The weekly schedule in force, any upcoming ones, and an editor for a new version. */
export function ScheduleCard({ selection }: { selection: Selection }) {
  const { api, signOut, t } = useSession();
  const { doctorId, clinic, type, canEdit, today, changed } = selection;
  const [versions, setVersions] = useState<AvailabilityVersion[] | null>(null);
  const [draft, setDraft] = useState<Draft>(toDraft(undefined));
  const [effectiveFrom, setEffectiveFrom] = useState(today);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handle = useCallback(
    (e: unknown) => {
      if (e instanceof ApiError && e.status === 401) return void signOut('expired');
      setMessage(e instanceof ApiError ? e.message : t('error.network'));
      setErrors(e instanceof ApiError ? e.fields : {});
    },
    [signOut, t],
  );

  const load = useCallback(async () => {
    const list = await api.request('GET', '/availability/versions', {
      schema: AvailabilityVersionList,
      query: { doctorId, clinicId: clinic.id, consultationTypeId: type.id },
    });
    setVersions(list.data);
    return list.data;
  }, [api, doctorId, clinic.id, type.id]);

  useEffect(() => {
    load()
      .then((list) => {
        // Start the editor from the newest schedule, on the first free date.
        setDraft(toDraft(list[0]?.weekly));
        setEffectiveFrom(list.some((v) => v.effectiveFrom === today) ? addDays(today, 1) : today);
      })
      .catch(handle);
  }, [load, handle, today]);

  const current = versions?.find((v) => v.effectiveFrom <= today);
  const upcoming = (versions ?? []).filter((v) => v.effectiveFrom > today).reverse();

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setErrors({});
    setMessage(null);
    setNotice(null);
    api
      .request('POST', '/availability/versions', {
        schema: AvailabilityVersion,
        body: {
          doctorUserId: doctorId,
          clinicId: clinic.id,
          consultationTypeId: type.id,
          effectiveFrom,
          weekly: fromDraft(draft),
          slotMinutes: Number(data.get('slotMinutes')),
          bufferMinutes: Number(data.get('bufferMinutes')),
        },
      })
      .then(async () => {
        await load();
        setNotice(t('availability.saved'));
        changed();
      })
      .catch(handle)
      .finally(() => setBusy(false));
  }

  const withdraw = (version: AvailabilityVersion) => {
    setBusy(true);
    setMessage(null);
    api
      .deleteAvailabilityVersion(version.id)
      .then(async () => {
        await load();
        changed();
      })
      .catch(handle)
      .finally(() => setBusy(false));
  };

  const update = (day: Weekday, sessions: Draft[Weekday]) =>
    setDraft((d) => ({ ...d, [day]: sessions }));

  const summary = (v: AvailabilityVersion) => (
    <>
      <ul className="week">
        {WEEK.map((day) => (
          <li key={day}>
            <span>{t(`weekday.${day}`)}</span>
            <span>
              {v.weekly[day]?.length
                ? v.weekly[day]!.map((s) => `${s.start}–${s.end}`).join(', ')
                : t('availability.dayOff')}
            </span>
          </li>
        ))}
      </ul>
      <p className="hint">
        {t('availability.slotSummary', { minutes: v.slotMinutes })}
        {v.bufferMinutes > 0 &&
          ` · ${t('availability.bufferSummary', { minutes: v.bufferMinutes })}`}
      </p>
    </>
  );

  return (
    <section aria-labelledby="schedule-title" className="card">
      <h2 id="schedule-title">{t('availability.scheduleTitle')}</h2>
      {versions && !current && upcoming.length === 0 && <p>{t('availability.noSchedule')}</p>}
      {current && (
        <div data-testid="schedule-current">
          <h3>{t('availability.inForce', { date: current.effectiveFrom })}</h3>
          {summary(current)}
        </div>
      )}
      {upcoming.map((v) => (
        <div key={v.id} data-testid={`schedule-${v.effectiveFrom}`}>
          <div className="card-header">
            <h3>{t('availability.upcoming', { date: v.effectiveFrom })}</h3>
            {canEdit && (
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => withdraw(v)}
              >
                {t('availability.withdraw')}
              </button>
            )}
          </div>
          {summary(v)}
        </div>
      ))}

      {canEdit && versions && (
        <form className="week-editor" onSubmit={save} noValidate>
          <h3>{t('availability.editTitle')}</h3>
          <p className="hint">{t('availability.editHelp')}</p>
          <div className="inline-form">
            <div>
              <label htmlFor="effective-from">{t('availability.effectiveFrom')}</label>
              <input
                id="effective-from"
                type="date"
                min={today}
                required
                value={effectiveFrom}
                onChange={(e) => setEffectiveFrom(e.target.value)}
              />
            </div>
            <div>
              <label htmlFor="slot-minutes">{t('availability.slotMinutes')}</label>
              <input
                id="slot-minutes"
                name="slotMinutes"
                type="number"
                min={5}
                max={240}
                step={5}
                required
                defaultValue={versions[0]?.slotMinutes ?? type.defaultDurationMin}
              />
            </div>
            <div>
              <label htmlFor="buffer-minutes">{t('availability.bufferMinutes')}</label>
              <input
                id="buffer-minutes"
                name="bufferMinutes"
                type="number"
                min={0}
                max={120}
                step={5}
                required
                defaultValue={versions[0]?.bufferMinutes ?? 0}
              />
            </div>
          </div>
          {WEEK.map((day) => {
            const dayName = t(`weekday.${day}`);
            const problem = errors[`weekly.${day}`];
            return (
              <fieldset key={day} data-testid={`day-${day}`}>
                <legend>{dayName}</legend>
                {draft[day].length === 0 && (
                  <span className="hint">{t('availability.dayOff')}</span>
                )}
                {draft[day].map((s, i) => {
                  const n = i + 1;
                  const sessionProblem = errors[`weekly.${day}.${i}`];
                  const set = (field: 'start' | 'end', value: string) =>
                    update(
                      day,
                      draft[day].map((x, j) => (j === i ? { ...x, [field]: value } : x)),
                    );
                  return (
                    <span className="session" key={i}>
                      <input
                        type="time"
                        aria-label={t('availability.sessionStart', { day: dayName, n })}
                        value={s.start}
                        required
                        aria-invalid={sessionProblem ? true : undefined}
                        onChange={(e) => set('start', e.target.value)}
                      />
                      –
                      <input
                        type="time"
                        aria-label={t('availability.sessionEnd', { day: dayName, n })}
                        value={s.end}
                        required
                        aria-invalid={sessionProblem ? true : undefined}
                        onChange={(e) => set('end', e.target.value)}
                      />
                      <button
                        type="button"
                        className="secondary"
                        aria-label={`${t('availability.removeSession')} (${dayName} ${n})`}
                        onClick={() =>
                          update(
                            day,
                            draft[day].filter((_, j) => j !== i),
                          )
                        }
                      >
                        ×
                      </button>
                      {sessionProblem && <span className="field-error">{sessionProblem}</span>}
                    </span>
                  );
                })}
                <button
                  type="button"
                  className="secondary"
                  aria-label={`${t('availability.addSession')} (${dayName})`}
                  onClick={() => {
                    const last = draft[day].at(-1);
                    update(day, [
                      ...draft[day],
                      last ? { start: last.end, end: last.end } : { start: '10:00', end: '13:00' },
                    ]);
                  }}
                >
                  + {t('availability.addSession')}
                </button>
                {problem && <span className="field-error">{problem}</span>}
              </fieldset>
            );
          })}
          <button type="submit" className="primary" disabled={busy}>
            {t('availability.saveSchedule')}
          </button>
        </form>
      )}
      {message && (
        <p role="alert" className="alert">
          {message}
        </p>
      )}
      {notice && (
        <p role="status" className="hint">
          {notice}
        </p>
      )}
    </section>
  );
}
