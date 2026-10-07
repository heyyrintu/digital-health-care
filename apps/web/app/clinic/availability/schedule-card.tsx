'use client';

import { ApiError } from '@dhc/api-client';
import { AvailabilityVersion, AvailabilityVersionList, type WeeklySchedule } from '@dhc/contracts';
import { addDays, type Weekday } from '@dhc/domain';
import { Button, Input, Label } from '@dhc/ui-web';
import { Plus, X } from 'lucide-react';
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
      <ul className="divide-y divide-border/60 rounded-xl border border-border/60 bg-background/60">
        {WEEK.map((day) => (
          <li
            key={day}
            className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-3 px-3.5 py-2.5 text-sm"
          >
            <span className="font-semibold">{t(`weekday.${day}`)}</span>
            <span className={v.weekly[day]?.length ? 'tabular' : 'text-muted-foreground'}>
              {v.weekly[day]?.length
                ? v.weekly[day]!.map((s) => `${s.start}–${s.end}`).join(', ')
                : t('availability.dayOff')}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-muted-foreground">
        {t('availability.slotSummary', { minutes: v.slotMinutes })}
        {v.bufferMinutes > 0 &&
          ` · ${t('availability.bufferSummary', { minutes: v.bufferMinutes })}`}
      </p>
    </>
  );

  return (
    <section aria-labelledby="schedule-title" className="surface space-y-6 p-5 sm:p-6">
      <h2 id="schedule-title" className="font-display text-lg font-bold">
        {t('availability.scheduleTitle')}
      </h2>
      {versions && !current && upcoming.length === 0 && (
        <p className="rounded-xl bg-muted p-4 text-sm text-muted-foreground">
          {t('availability.noSchedule')}
        </p>
      )}
      {current && (
        <div data-testid="schedule-current">
          <h3 className="mb-3 text-sm font-semibold">
            {t('availability.inForce', { date: current.effectiveFrom })}
          </h3>
          {summary(current)}
        </div>
      )}
      {upcoming.map((v) => (
        <div key={v.id} data-testid={`schedule-${v.effectiveFrom}`}>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">
              {t('availability.upcoming', { date: v.effectiveFrom })}
            </h3>
            {canEdit && (
              <Button type="button" variant="outline" disabled={busy} onClick={() => withdraw(v)}>
                {t('availability.withdraw')}
              </Button>
            )}
          </div>
          {summary(v)}
        </div>
      ))}

      {canEdit && versions && (
        <form className="space-y-4 border-t border-border/60 pt-6" onSubmit={save} noValidate>
          <div>
            <h3 className="font-display text-base font-bold">{t('availability.editTitle')}</h3>
            <p className="mt-1 text-sm text-muted-foreground">{t('availability.editHelp')}</p>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="effective-from">{t('availability.effectiveFrom')}</Label>
              <Input
                id="effective-from"
                type="date"
                min={today}
                required
                value={effectiveFrom}
                onChange={(e) => setEffectiveFrom(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="slot-minutes">{t('availability.slotMinutes')}</Label>
              <Input
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
            <div className="space-y-2">
              <Label htmlFor="buffer-minutes">{t('availability.bufferMinutes')}</Label>
              <Input
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
          <div className="rounded-xl border border-border/60">
            {WEEK.map((day) => {
              const dayName = t(`weekday.${day}`);
              const problem = errors[`weekly.${day}`];
              return (
                <fieldset
                  key={day}
                  data-testid={`day-${day}`}
                  className="flex flex-wrap items-center gap-2 border-t border-border/60 px-3.5 py-3 first:border-t-0"
                >
                  <legend className="float-left w-full pb-1 text-sm font-semibold sm:w-24 sm:pb-0">
                    {dayName}
                  </legend>
                  {draft[day].length === 0 && (
                    <span className="text-sm text-muted-foreground">
                      {t('availability.dayOff')}
                    </span>
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
                      <span
                        className="inline-flex flex-wrap items-center gap-1.5 rounded-xl bg-accent/60 p-1"
                        key={i}
                      >
                        <Input
                          type="time"
                          className="w-[7.5rem]"
                          aria-label={t('availability.sessionStart', { day: dayName, n })}
                          value={s.start}
                          required
                          aria-invalid={sessionProblem ? true : undefined}
                          onChange={(e) => set('start', e.target.value)}
                        />
                        <span aria-hidden className="text-muted-foreground">
                          –
                        </span>
                        <Input
                          type="time"
                          className="w-[7.5rem]"
                          aria-label={t('availability.sessionEnd', { day: dayName, n })}
                          value={s.end}
                          required
                          aria-invalid={sessionProblem ? true : undefined}
                          onChange={(e) => set('end', e.target.value)}
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label={`${t('availability.removeSession')} (${dayName} ${n})`}
                          onClick={() =>
                            update(
                              day,
                              draft[day].filter((_, j) => j !== i),
                            )
                          }
                        >
                          <X aria-hidden />
                        </Button>
                        {sessionProblem && (
                          <span className="basis-full px-1 text-xs font-medium text-destructive">
                            {sessionProblem}
                          </span>
                        )}
                      </span>
                    );
                  })}
                  <Button
                    type="button"
                    variant="ghost"
                    className="text-primary"
                    aria-label={`${t('availability.addSession')} (${dayName})`}
                    onClick={() => {
                      const last = draft[day].at(-1);
                      update(day, [
                        ...draft[day],
                        last
                          ? { start: last.end, end: last.end }
                          : { start: '10:00', end: '13:00' },
                      ]);
                    }}
                  >
                    <Plus aria-hidden />
                    {t('availability.addSession')}
                  </Button>
                  {problem && (
                    <span className="basis-full text-xs font-medium text-destructive">
                      {problem}
                    </span>
                  )}
                </fieldset>
              );
            })}
          </div>
          <Button type="submit" className="w-full sm:w-auto" disabled={busy}>
            {t('availability.saveSchedule')}
          </Button>
        </form>
      )}
      {message && (
        <p
          role="alert"
          className="rounded-xl bg-danger-soft p-4 text-sm font-medium text-destructive"
        >
          {message}
        </p>
      )}
      {notice && (
        <p
          role="status"
          className="rounded-xl bg-success-soft p-4 text-sm font-medium text-success"
        >
          {notice}
        </p>
      )}
    </section>
  );
}
