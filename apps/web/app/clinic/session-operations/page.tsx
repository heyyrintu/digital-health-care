'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ApiError } from '@dhc/api-client';
import {
  ClinicOperation,
  ClinicOperationList,
  ClinicOperationOptions,
  type PreviewClinicOperation,
} from '@dhc/contracts';
import { istDateKey } from '@dhc/domain';
import type { MessageKey } from '@dhc/i18n';
import { Button, Field, Input, NativeSelect, Textarea } from '@dhc/ui-web';
import { useSession } from '../session-provider';
import { ClinicShell, NotAllowed } from '../shell';
export default function Page() {
  return (
    <ClinicShell>{(me) => (me.role === 'patient' ? <NotAllowed /> : <Operations />)}</ClinicShell>
  );
}
function Operations() {
  const { api, t, me } = useSession(),
    [options, setOptions] = useState<ReturnType<typeof ClinicOperationOptions.parse> | null>(null),
    [kind, setKind] = useState<'cancel' | 'reschedule' | 'delay'>('cancel'),
    [doctor, setDoctor] = useState(''),
    [clinic, setClinic] = useState(''),
    [date, setDate] = useState(istDateKey(new Date())),
    [from, setFrom] = useState('09:00'),
    [to, setTo] = useState('13:00'),
    [reason, setReason] = useState(''),
    [targetDate, setTargetDate] = useState(''),
    [targetTime, setTargetTime] = useState('09:00'),
    [targetClinic, setTargetClinic] = useState(''),
    [delay, setDelay] = useState(30),
    [notify, setNotify] = useState(false),
    [op, setOp] = useState<ClinicOperation | null>(null),
    [history, setHistory] = useState<ClinicOperation[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [confirmed, setConfirmed] = useState(false),
    [manual, setManual] = useState(false),
    [uncertain, setUncertain] = useState(false);
  const pending = useRef<PreviewClinicOperation | null>(null);
  const load = useCallback(
    async (next?: string) => {
      const r = await api.request('GET', '/clinic-operations', {
        schema: ClinicOperationList,
        query: { cursor: next },
      });
      setHistory((old) => (next ? [...old, ...r.data] : r.data));
      setCursor(r.nextCursor);
    },
    [api],
  );
  useEffect(() => {
    void api
      .request('GET', '/clinic-operations/options', { schema: ClinicOperationOptions })
      .then((r) => {
        setOptions(r);
        setDoctor(r.doctors[0]?.id ?? '');
        setClinic(r.clinics[0]?.id ?? '');
        setTargetClinic(r.clinics[0]?.id ?? '');
      })
      .catch((e) => setError(e instanceof Error ? e.message : t('clinicOps.failed')));
    void load().catch((e) => setError(e instanceof Error ? e.message : t('clinicOps.failed')));
  }, [api, load, t]);
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('clinicOps.failed'));
    } finally {
      setBusy(false);
    }
  }
  async function preview() {
    pending.current ??= {
      id: crypto.randomUUID(),
      kind,
      doctorId: doctor,
      clinicId: clinic,
      date,
      from,
      to,
      reason,
      delayMinutes: kind === 'delay' ? delay : 0,
      notify,
      ...(kind === 'reschedule' ? { targetDate, targetTime, targetClinicId: targetClinic } : {}),
    };
    try {
      const r = await api.request('POST', '/clinic-operations/preview', {
        schema: ClinicOperation,
        body: pending.current,
      });
      pending.current = null;
      setOp(r);
      setConfirmed(false);
      setManual(false);
      await load();
    } catch (e) {
      if (e instanceof ApiError && e.status < 500) pending.current = null;
      throw e;
    }
  }
  async function apply() {
    if (!op) return;
    setUncertain(true);
    try {
      const r = await api.request('POST', `/clinic-operations/${op.id}/apply`, {
        schema: ClinicOperation,
        body: { revision: op.revision, confirmed: true, acknowledgeManual: manual },
      });
      setOp(r);
      setUncertain(false);
      await load();
    } catch (e) {
      if (e instanceof ApiError && e.status < 500) setUncertain(false);
      throw e;
    }
  }
  function restore(r: ClinicOperation) {
    const b = r.request;
    setOp(r);
    setKind(b.kind);
    setDoctor(b.doctorId);
    setClinic(b.clinicId);
    setDate(b.date);
    setFrom(b.from);
    setTo(b.to);
    setReason(b.reason);
    setDelay(b.delayMinutes);
    setNotify(b.notify);
    setTargetClinic(b.targetClinicId ?? b.clinicId);
    setTargetDate(b.targetDate ?? '');
    setTargetTime(b.targetTime ?? '09:00');
    setConfirmed(false);
    setManual(false);
  }
  const frozen = busy || !!pending.current || uncertain;
  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <h1 className="font-display text-2xl font-bold">{t('clinicOps.title')}</h1>
      <p>{t('clinicOps.intro')}</p>
      <p className="rounded-xl border p-3 text-sm">{t('clinicOps.policy')}</p>
      {error && (
        <p role="alert" className="rounded-xl border p-3">
          {error}
        </p>
      )}
      <form
        className="surface space-y-4 p-4 sm:p-6"
        onSubmit={(e) => {
          e.preventDefault();
          void run(preview);
        }}
      >
        <fieldset
          className="grid gap-4 sm:grid-cols-2"
          disabled={frozen}
          onChange={() => {
            if (!frozen) {
              setOp(null);
              setConfirmed(false);
              setManual(false);
            }
          }}
        >
          <Field label={t('clinicOps.action')}>
            <NativeSelect value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
              {['cancel', 'reschedule', 'delay'].map((v) => (
                <option key={v} value={v}>
                  {t(`clinicOps.${v}` as MessageKey)}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label={t('clinicOps.doctor')}>
            <NativeSelect required value={doctor} onChange={(e) => setDoctor(e.target.value)}>
              <option value="">{t('clinicOps.choose')}</option>
              {options?.doctors.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label={t('clinicOps.clinic')}>
            <NativeSelect required value={clinic} onChange={(e) => setClinic(e.target.value)}>
              <option value="">{t('clinicOps.choose')}</option>
              {options?.clinics.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label={t('clinicOps.date')}>
            <Input type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label={t('clinicOps.from')}>
            <Input type="time" required value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label={t('clinicOps.to')}>
            <Input type="time" required value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
          {kind === 'reschedule' && (
            <>
              <Field label={t('clinicOps.targetDate')}>
                <Input
                  type="date"
                  required
                  value={targetDate}
                  onChange={(e) => setTargetDate(e.target.value)}
                />
              </Field>
              <Field label={t('clinicOps.targetTime')}>
                <Input
                  type="time"
                  required
                  value={targetTime}
                  onChange={(e) => setTargetTime(e.target.value)}
                />
              </Field>
              <Field label={t('clinicOps.targetClinic')}>
                <NativeSelect
                  value={targetClinic}
                  onChange={(e) => setTargetClinic(e.target.value)}
                >
                  {options?.clinics.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            </>
          )}
          {kind === 'delay' && (
            <Field label={t('clinicOps.minutes')}>
              <Input
                type="number"
                min={0}
                max={240}
                required
                value={delay}
                onChange={(e) => setDelay(Number(e.target.value))}
              />
            </Field>
          )}
          <div className="sm:col-span-2">
            <Field label={t('clinicOps.reason')}>
              <Textarea
                required
                maxLength={300}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </Field>
          </div>
          <label className="flex items-start gap-2 sm:col-span-2">
            <input
              type="checkbox"
              className="mt-1 h-5 w-5 shrink-0"
              checked={notify}
              disabled={!options?.notificationAvailable}
              onChange={(e) => setNotify(e.target.checked)}
            />
            {t('clinicOps.notify')}
          </label>
        </fieldset>
        {!options?.notificationAvailable && <p>{t('clinicOps.notConfigured')}</p>}
        <p className="text-sm">{t('clinicOps.confirmationNote')}</p>
        <Button type="submit" disabled={busy || uncertain || !options}>
          {t(pending.current ? 'clinicOps.recoverPreview' : 'clinicOps.preview')}
        </Button>
      </form>
      {op && (
        <section className="surface space-y-4 p-4 sm:p-6" aria-label={t('clinicOps.previewResult')}>
          <h2 className="font-display text-xl font-bold">
            {t(op.state === 'applied' ? 'clinicOps.applied' : 'clinicOps.previewResult')}
          </h2>
          <p className="break-all">{t('clinicOps.reference', { id: op.id })}</p>
          {op.state === 'applied' ? (
            <p role="status">
              {t('clinicOps.result', {
                changed: op.changedCount,
                manual: op.manualCount,
                notices: op.notificationsQueued,
              })}
            </p>
          ) : (
            <p>
              {t('clinicOps.previewCounts', {
                ready: op.rows.filter((r) => r.eligible).length,
                manual: op.manualCount,
                date: new Date(op.expiresAt).toLocaleString(),
              })}
            </p>
          )}
          <ul className="space-y-3" aria-label={t('clinicOps.affected')}>
            {op.rows.map((r) => (
              <li className="rounded-xl border p-3" key={r.id}>
                <p className="font-semibold">
                  {r.patientName} · {r.uhid}
                </p>
                <p>
                  {new Date(r.startAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} ·{' '}
                  {t(`status.${r.status}` as MessageKey)}
                </p>
                {r.eligible ? (
                  <p>{t('clinicOps.ready')}</p>
                ) : (
                  <p>{t(`clinicOps.issue.${r.issue}` as MessageKey)}</p>
                )}
                {r.targetAt && (
                  <p>
                    {t('clinicOps.target')}:{' '}
                    {new Date(r.targetAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}
                  </p>
                )}
                {r.targetIssue && (
                  <p role="alert">{t(`clinicOps.issue.${r.targetIssue}` as MessageKey)}</p>
                )}
                {r.newAppointmentId && (
                  <Link className="underline" href={`/clinic/appointments/${r.newAppointmentId}`}>
                    {t('clinicOps.viewReplacement')}
                  </Link>
                )}
              </li>
            ))}
          </ul>
          {op.state === 'preview' && (
            <>
              <label className="flex items-start gap-2">
                <input
                  className="mt-1 h-5 w-5 shrink-0"
                  type="checkbox"
                  checked={confirmed}
                  disabled={frozen}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                {t('clinicOps.confirm')}
              </label>
              {op.manualCount > 0 && (
                <label className="flex items-start gap-2">
                  <input
                    className="mt-1 h-5 w-5 shrink-0"
                    type="checkbox"
                    checked={manual}
                    disabled={frozen}
                    onChange={(e) => setManual(e.target.checked)}
                  />
                  {t('clinicOps.manualAck')}
                </label>
              )}
              <Button
                variant="destructive"
                disabled={
                  busy ||
                  !confirmed ||
                  (op.manualCount > 0 && !manual) ||
                  !op.canApply ||
                  op.createdByUserId !== me?.user.id
                }
                onClick={() => void run(apply)}
              >
                {t(uncertain ? 'clinicOps.recoverApply' : 'clinicOps.apply')}
              </Button>
              <p>{t('clinicOps.recovery')}</p>
            </>
          )}
        </section>
      )}
      <section className="space-y-3">
        <h2 className="font-display text-xl font-bold">{t('clinicOps.history')}</h2>
        <Button variant="outline" disabled={frozen} onClick={() => void run(() => load())}>
          {t('clinicOps.refresh')}
        </Button>
        {history.map((r) => (
          <article
            className="surface flex flex-wrap items-center justify-between gap-3 p-3"
            key={r.id}
          >
            <p>
              {t(`clinicOps.${r.kind}` as MessageKey)} · {r.request.date} ·{' '}
              {t(r.state === 'applied' ? 'clinicOps.applied' : 'clinicOps.previewResult')}
            </p>
            <Button
              variant="outline"
              disabled={frozen}
              onClick={() =>
                void run(async () =>
                  restore(
                    await api.request('GET', `/clinic-operations/${r.id}`, {
                      schema: ClinicOperation,
                    }),
                  ),
                )
              }
            >
              {t('clinicOps.open')}
            </Button>
          </article>
        ))}
        {cursor && (
          <Button disabled={frozen} onClick={() => void run(() => load(cursor))}>
            {t('clinicOps.more')}
          </Button>
        )}
      </section>
    </div>
  );
}
