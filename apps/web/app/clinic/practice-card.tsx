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
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useSession } from './session-provider';

const MODES: ConsultationMode[] = ['in_person', 'video', 'audio'];

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
          },
        }),
      );
      setNotice(t('practice.rulesSaved'));
    });
  }

  const alert = (section: string) =>
    errors[section] && (
      <p role="alert" className="alert">
        {errors[section]}
      </p>
    );

  return (
    <section aria-labelledby="practice-title" className="card">
      <h2 id="practice-title">{t('practice.title')}</h2>
      {alert('load')}

      <h3>{t('practice.clinicsTitle')}</h3>
      {clinics && clinics.length === 0 && <p>{t('practice.noClinics')}</p>}
      {clinics && clinics.length > 0 && (
        <ul className="tag-list">
          {clinics.map((c) => (
            <li key={c.id} data-testid={`clinic-${c.name}`}>
              <strong>{c.name}</strong>
              {c.address && <span className="hint">{c.address}</span>}
              {!c.active && <span className="pill">{t('practice.inactive')}</span>}
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => void setClinicActive(c, !c.active)}
              >
                {c.active ? t('practice.deactivate') : t('practice.activate')}
              </button>
            </li>
          ))}
        </ul>
      )}
      <form className="inline-form" onSubmit={addClinic}>
        <div>
          <label htmlFor="clinic-name">{t('practice.clinicName')}</label>
          <input id="clinic-name" name="name" required maxLength={80} />
        </div>
        <div>
          <label htmlFor="clinic-address">{t('practice.clinicAddress')}</label>
          <input id="clinic-address" name="address" maxLength={300} />
        </div>
        <button type="submit" disabled={busy}>
          {t('practice.addClinic')}
        </button>
      </form>
      {alert('clinics')}

      <h3>{t('practice.typesTitle')}</h3>
      {types && types.length === 0 && <p>{t('practice.noTypes')}</p>}
      {types && types.length > 0 && (
        <ul className="tag-list">
          {types.map((ty) => (
            <li key={ty.id} data-testid={`type-${ty.name}`}>
              <strong>{ty.name}</strong>
              <span className="hint">
                {t('practice.typeSummary', {
                  mode: t(`mode.${ty.mode}`),
                  minutes: ty.defaultDurationMin,
                  fee: formatInr(ty.feePaise, locale),
                })}
                {ty.followUpFeePaise !== null &&
                  ` · ${t('practice.followUp', { fee: formatInr(ty.followUpFeePaise, locale) })}`}
              </span>
              {ty.requiresPrepayment && <span className="pill">{t('practice.prepay')}</span>}
              {!ty.active && <span className="pill">{t('practice.inactive')}</span>}
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => void setTypeActive(ty, !ty.active)}
              >
                {ty.active ? t('practice.deactivate') : t('practice.activate')}
              </button>
            </li>
          ))}
        </ul>
      )}
      <form className="inline-form" onSubmit={addType}>
        <div>
          <label htmlFor="type-name">{t('practice.typeName')}</label>
          <input id="type-name" name="name" required maxLength={60} />
        </div>
        <div>
          <label htmlFor="type-mode">{t('practice.typeMode')}</label>
          <select id="type-mode" name="mode" defaultValue="in_person">
            {MODES.map((m) => (
              <option key={m} value={m}>
                {t(`mode.${m}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="narrow-field">
          <label htmlFor="type-duration">{t('practice.typeDuration')}</label>
          <input
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
        <div className="narrow-field">
          <label htmlFor="type-fee">{t('practice.typeFee')}</label>
          <input id="type-fee" name="fee" type="number" min={0} step="0.01" required />
        </div>
        <div className="narrow-field">
          <label htmlFor="type-follow-up">{t('practice.typeFollowUpFee')}</label>
          <input id="type-follow-up" name="followUpFee" type="number" min={0} step="0.01" />
        </div>
        <label className="checkbox">
          <input type="checkbox" name="prepay" /> {t('practice.typePrepay')}
        </label>
        <button type="submit" disabled={busy}>
          {t('practice.addType')}
        </button>
      </form>
      {alert('types')}

      <h3>{t('practice.rulesTitle')}</h3>
      {rules && (
        <form className="inline-form" onSubmit={saveRules}>
          <div>
            <label htmlFor="rules-horizon">{t('practice.horizon')}</label>
            <input
              id="rules-horizon"
              name="horizonDays"
              type="number"
              min={1}
              max={365}
              required
              defaultValue={rules.horizonDays}
            />
          </div>
          <div>
            <label htmlFor="rules-cutoff">{t('practice.cutoff')}</label>
            <input
              id="rules-cutoff"
              name="cutoff"
              type="number"
              min={0}
              max={1440}
              required
              defaultValue={rules.sameDayCutoffMinutes}
            />
          </div>
          <button type="submit" disabled={busy}>
            {t('common.save')}
          </button>
        </form>
      )}
      {notice && (
        <p role="status" className="hint">
          {notice}
        </p>
      )}
      {alert('rules')}
    </section>
  );
}
