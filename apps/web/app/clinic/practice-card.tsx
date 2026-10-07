'use client';

import { ApiError } from '@dhc/api-client';
import {
  BookingRules,
  Clinic,
  ClinicList,
  ConsultationType,
  ConsultationTypeList,
  type ConsultationMode,
} from '@dhc/contracts';
import { formatInr, rupeesToPaise } from '@dhc/domain';
import { Button, Input, NativeSelect } from '@dhc/ui-web';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useSession } from './session-provider';

const MODES: ConsultationMode[] = ['in_person', 'video', 'audio'];

const H3 = 'mb-3 mt-7 text-xs font-bold uppercase tracking-wide text-muted-foreground';
const ROW = 'flex flex-wrap items-center gap-x-3 gap-y-1 py-3';
const PILL = 'rounded-full bg-accent px-2.5 py-0.5 text-xs font-semibold text-accent-foreground';
const FORM = 'mt-4 grid items-end gap-3 sm:grid-cols-2';
const FIELD = 'space-y-1.5';
const LABEL = 'block text-sm font-medium';
const ALERT = 'mt-3 rounded-xl bg-danger-soft px-4 py-3 text-sm font-medium text-destructive';

/** Clinic admin: clinics, consultation types with fees, and booking rules (PRD §4.3). */
export function PracticeCard() {
  const { api, locale, signOut, t } = useSession();
  const [clinics, setClinics] = useState<Clinic[] | null>(null);
  const [types, setTypes] = useState<ConsultationType[] | null>(null);
  const [rules, setRules] = useState<BookingRules | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [c, ty, r] = await Promise.all([
      api.request('GET', '/clinics', { schema: ClinicList }),
      api.request('GET', '/consultation-types', { schema: ConsultationTypeList }),
      api.request('GET', '/booking-rules', { schema: BookingRules }),
    ]);
    setClinics(c.data);
    setTypes(ty.data);
    setRules(r);
  }, [api]);

  const handle = useCallback(
    (section: string, e: unknown) => {
      if (e instanceof ApiError && e.status === 401) return void signOut('expired');
      setErrors({ [section]: e instanceof ApiError ? e.message : t('error.network') });
    },
    [signOut, t],
  );

  useEffect(() => {
    load().catch((e: unknown) => handle('load', e));
  }, [load, handle]);

  async function run(section: string, action: () => Promise<void>) {
    setBusy(true);
    setErrors({});
    setNotice(null);
    try {
      await action();
    } catch (e) {
      handle(section, e);
    } finally {
      setBusy(false);
    }
  }

  function addClinic(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const address = String(data.get('address') ?? '').trim();
    void run('clinics', async () => {
      await api.request('POST', '/clinics', {
        schema: Clinic,
        body: { name: String(data.get('name') ?? ''), address: address || null },
      });
      form.reset();
      await load();
    });
  }

  const setClinicActive = (clinic: Clinic, active: boolean) =>
    run('clinics', async () => {
      await api.request('PATCH', `/clinics/${clinic.id}`, { schema: Clinic, body: { active } });
      await load();
    });

  function addType(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const followUp = String(data.get('followUpFee') ?? '').trim();
    void run('types', async () => {
      await api.request('POST', '/consultation-types', {
        schema: ConsultationType,
        body: {
          name: String(data.get('name') ?? ''),
          mode: String(data.get('mode')) as ConsultationMode,
          defaultDurationMin: Number(data.get('duration')),
          feePaise: rupeesToPaise(Number(data.get('fee'))),
          followUpFeePaise: followUp ? rupeesToPaise(Number(followUp)) : null,
          requiresPrepayment: data.get('prepay') === 'on',
        },
      });
      form.reset();
      await load();
    });
  }

  const setTypeActive = (type: ConsultationType, active: boolean) =>
    run('types', async () => {
      await api.request('PATCH', `/consultation-types/${type.id}`, {
        schema: ConsultationType,
        body: { active },
      });
      await load();
    });

  function saveRules(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void run('rules', async () => {
      setRules(
        await api.request('PUT', '/booking-rules', {
          schema: BookingRules,
          body: {
            horizonDays: Number(data.get('horizonDays')),
            sameDayCutoffMinutes: Number(data.get('cutoff')),
            overbookPerDay: Number(data.get('overbook')),
          },
        }),
      );
      setNotice(t('practice.rulesSaved'));
    });
  }

  const alert = (section: string) =>
    errors[section] && (
      <p role="alert" className={ALERT}>
        {errors[section]}
      </p>
    );

  return (
    <section aria-labelledby="practice-title" className="surface p-4 sm:p-6">
      <h2 id="practice-title" className="font-display text-lg font-bold">
        {t('practice.title')}
      </h2>
      {alert('load')}

      <h3 className={H3}>{t('practice.clinicsTitle')}</h3>
      {clinics && clinics.length === 0 && <p>{t('practice.noClinics')}</p>}
      {clinics && clinics.length > 0 && (
        <ul className="divide-y divide-border/70">
          {clinics.map((c) => (
            <li key={c.id} data-testid={`clinic-${c.name}`} className={ROW}>
              <strong>{c.name}</strong>
              {c.address && <span className="text-sm text-muted-foreground">{c.address}</span>}
              {!c.active && <span className={PILL}>{t('practice.inactive')}</span>}
              <Button
                type="button"
                variant="outline"
                className="ml-auto"
                disabled={busy}
                onClick={() => void setClinicActive(c, !c.active)}
              >
                {c.active ? t('practice.deactivate') : t('practice.activate')}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form className={FORM} onSubmit={addClinic}>
        <div className={FIELD}>
          <label className={LABEL} htmlFor="clinic-name">
            {t('practice.clinicName')}
          </label>
          <Input id="clinic-name" name="name" required maxLength={80} />
        </div>
        <div className={FIELD}>
          <label className={LABEL} htmlFor="clinic-address">
            {t('practice.clinicAddress')}
          </label>
          <Input id="clinic-address" name="address" maxLength={300} />
        </div>
        <Button type="submit" disabled={busy} className="sm:col-span-2 sm:justify-self-start">
          {t('practice.addClinic')}
        </Button>
      </form>
      {alert('clinics')}

      <h3 className={H3}>{t('practice.typesTitle')}</h3>
      {types && types.length === 0 && <p>{t('practice.noTypes')}</p>}
      {types && types.length > 0 && (
        <ul className="divide-y divide-border/70">
          {types.map((ty) => (
            <li key={ty.id} data-testid={`type-${ty.name}`} className={ROW}>
              <strong>{ty.name}</strong>
              <span className="text-sm text-muted-foreground">
                {t('practice.typeSummary', {
                  mode: t(`mode.${ty.mode}`),
                  minutes: ty.defaultDurationMin,
                  fee: formatInr(ty.feePaise, locale),
                })}
                {ty.followUpFeePaise !== null &&
                  ` · ${t('practice.followUp', { fee: formatInr(ty.followUpFeePaise, locale) })}`}
              </span>
              {ty.requiresPrepayment && <span className={PILL}>{t('practice.prepay')}</span>}
              {!ty.active && <span className={PILL}>{t('practice.inactive')}</span>}
              <Button
                type="button"
                variant="outline"
                className="ml-auto"
                disabled={busy}
                onClick={() => void setTypeActive(ty, !ty.active)}
              >
                {ty.active ? t('practice.deactivate') : t('practice.activate')}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form className={FORM} onSubmit={addType}>
        <div className={FIELD}>
          <label className={LABEL} htmlFor="type-name">
            {t('practice.typeName')}
          </label>
          <Input id="type-name" name="name" required maxLength={60} />
        </div>
        <div className={FIELD}>
          <label className={LABEL} htmlFor="type-mode">
            {t('practice.typeMode')}
          </label>
          <NativeSelect id="type-mode" name="mode" defaultValue="in_person">
            {MODES.map((m) => (
              <option key={m} value={m}>
                {t(`mode.${m}`)}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className={FIELD}>
          <label className={LABEL} htmlFor="type-duration">
            {t('practice.typeDuration')}
          </label>
          <Input
            id="type-duration"
            name="duration"
            type="number"
            min={5}
            max={240}
            step={5}
            defaultValue={15}
            required
          />
        </div>
        <div className={FIELD}>
          <label className={LABEL} htmlFor="type-fee">
            {t('practice.typeFee')}
          </label>
          <Input id="type-fee" name="fee" type="number" min={0} step="0.01" required />
        </div>
        <div className={FIELD}>
          <label className={LABEL} htmlFor="type-follow-up">
            {t('practice.typeFollowUpFee')}
          </label>
          <Input id="type-follow-up" name="followUpFee" type="number" min={0} step="0.01" />
        </div>
        <label className="flex min-h-11 items-center gap-2 text-sm sm:col-span-2">
          <input type="checkbox" name="prepay" className="size-4 accent-primary" />{' '}
          {t('practice.typePrepay')}
        </label>
        <Button type="submit" disabled={busy} className="sm:col-span-2 sm:justify-self-start">
          {t('practice.addType')}
        </Button>
      </form>
      {alert('types')}

      <h3 className={H3}>{t('practice.rulesTitle')}</h3>
      {rules && (
        <form className={FORM} onSubmit={saveRules}>
          <div className={FIELD}>
            <label className={LABEL} htmlFor="rules-horizon">
              {t('practice.horizon')}
            </label>
            <Input
              id="rules-horizon"
              name="horizonDays"
              type="number"
              min={1}
              max={365}
              required
              defaultValue={rules.horizonDays}
            />
          </div>
          <div className={FIELD}>
            <label className={LABEL} htmlFor="rules-cutoff">
              {t('practice.cutoff')}
            </label>
            <Input
              id="rules-cutoff"
              name="cutoff"
              type="number"
              min={0}
              max={1440}
              required
              defaultValue={rules.sameDayCutoffMinutes}
            />
          </div>
          <div className={FIELD}>
            <label className={LABEL} htmlFor="rules-overbook">
              {t('practice.overbook')}
            </label>
            <Input
              id="rules-overbook"
              name="overbook"
              type="number"
              min={0}
              max={50}
              required
              defaultValue={rules.overbookPerDay}
            />
          </div>
          <Button type="submit" disabled={busy} className="sm:col-span-2 sm:justify-self-start">
            {t('common.save')}
          </Button>
        </form>
      )}
      {notice && (
        <p role="status" className="mt-3 text-sm font-medium text-success">
          {notice}
        </p>
      )}
      {alert('rules')}
    </section>
  );
}
