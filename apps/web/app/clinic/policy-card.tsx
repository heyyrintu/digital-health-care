'use client';

import { ApiError } from '@dhc/api-client';
import {
  ChartModel,
  MAX_UPLOAD_MB,
  OrganisationSettings,
  TunableSafetyRule,
  UploadType,
} from '@dhc/contracts';
import type { MessageKey } from '@dhc/i18n';
import { Button, Input } from '@dhc/ui-web';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useSession } from './session-provider';

const H3 = 'mb-3 mt-7 text-xs font-bold uppercase tracking-wide text-muted-foreground';
const HINT = 'text-sm text-muted-foreground';
const CHOICE = 'flex min-h-11 items-start gap-2 text-sm';
const BOX = 'mt-1 size-4 shrink-0 accent-primary';
const ALERT = 'mt-3 rounded-xl bg-danger-soft px-4 py-3 text-sm font-medium text-destructive';

const CHART_LABELS: Record<ChartModel, { label: MessageKey; hint: MessageKey }> = {
  shared: { label: 'policy.chartShared', hint: 'policy.chartSharedHint' },
  own_patients: { label: 'policy.chartOwn', hint: 'policy.chartOwnHint' },
};
const RULE_LABELS: Record<TunableSafetyRule, MessageKey> = {
  'SR-06': 'policy.ruleSR06',
  'SR-08': 'policy.ruleSR08',
  'SR-15': 'policy.ruleSR15',
};
const TYPE_LABELS: Record<UploadType, MessageKey> = {
  pdf: 'policy.typePdf',
  jpeg: 'policy.typeJpeg',
  png: 'policy.typePng',
  heic: 'policy.typeHeic',
};

/**
 * Clinic admin: who sees the chart, which non-critical safety alerts doctors see, and
 * what files the clinic accepts (PRD §9.2).
 */
export function PolicyCard() {
  const { api, signOut, t } = useSession();
  const [settings, setSettings] = useState<OrganisationSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const handle = useCallback(
    (e: unknown) => {
      if (e instanceof ApiError && e.status === 401) return void signOut('expired');
      setError(e instanceof ApiError ? e.message : t('error.network'));
    },
    [signOut, t],
  );

  useEffect(() => {
    api
      .request('GET', '/organisation-settings', { schema: OrganisationSettings })
      .then(setSettings, handle);
  }, [api, handle]);

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const body = {
      chartModel: String(data.get('chartModel')),
      // The form asks which alerts to show; the setting stores the hidden ones.
      hiddenSafetyRules: TunableSafetyRule.options.filter((r) => !data.has(`show-${r}`)),
      maxUploadMb: Number(data.get('maxUploadMb')),
      uploadTypes: UploadType.options.filter((u) => data.has(`type-${u}`)),
    };
    if (body.uploadTypes.length === 0) {
      setError(t('policy.typesRequired'));
      return;
    }
    setBusy(true);
    setError(null);
    setSaved(false);
    api
      .request('PUT', '/organisation-settings', { schema: OrganisationSettings, body })
      .then((next) => {
        setSettings(next);
        setSaved(true);
      }, handle)
      .finally(() => setBusy(false));
  }

  return (
    <section aria-labelledby="policy-title" className="surface p-4 sm:p-6">
      <h2 id="policy-title" className="font-display text-lg font-bold">
        {t('policy.title')}
      </h2>
      {settings && (
        <form onSubmit={save} onChange={() => setSaved(false)} data-testid="clinic-policies">
          <fieldset>
            <legend className={H3}>{t('policy.chartTitle')}</legend>
            {ChartModel.options.map((model) => (
              <label key={model} className={CHOICE}>
                <input
                  type="radio"
                  name="chartModel"
                  value={model}
                  defaultChecked={settings.chartModel === model}
                  className={BOX}
                />
                <span>
                  <span className="font-medium">{t(CHART_LABELS[model].label)}</span>
                  <span className={`block ${HINT}`}>{t(CHART_LABELS[model].hint)}</span>
                </span>
              </label>
            ))}
          </fieldset>

          <fieldset>
            <legend className={H3}>{t('policy.safetyTitle')}</legend>
            <p className={`mb-2 ${HINT}`}>{t('policy.safetyHint')}</p>
            {TunableSafetyRule.options.map((rule) => (
              <label key={rule} className={CHOICE}>
                <input
                  type="checkbox"
                  name={`show-${rule}`}
                  defaultChecked={!settings.hiddenSafetyRules.includes(rule)}
                  className={BOX}
                />
                <span>{t(RULE_LABELS[rule])}</span>
              </label>
            ))}
          </fieldset>

          <fieldset>
            <legend className={H3}>{t('policy.filesTitle')}</legend>
            <div className="max-w-48 space-y-1.5">
              <label className="block text-sm font-medium" htmlFor="policy-max-mb">
                {t('policy.maxUploadMb', { max: MAX_UPLOAD_MB })}
              </label>
              <Input
                id="policy-max-mb"
                name="maxUploadMb"
                type="number"
                min={1}
                max={MAX_UPLOAD_MB}
                required
                defaultValue={settings.maxUploadMb}
              />
            </div>
            <p className={`mb-1 mt-3 text-sm font-medium`}>{t('policy.typesLabel')}</p>
            <div className="flex flex-wrap gap-x-5">
              {UploadType.options.map((type) => (
                <label key={type} className={CHOICE}>
                  <input
                    type="checkbox"
                    name={`type-${type}`}
                    defaultChecked={settings.uploadTypes.includes(type)}
                    className={BOX}
                  />
                  <span>{t(TYPE_LABELS[type])}</span>
                </label>
              ))}
            </div>
            <p className={`mt-1 ${HINT}`}>{t('policy.filesHint')}</p>
          </fieldset>

          <div className="mt-5 flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={busy}>
              {t('common.save')}
            </Button>
            {saved && (
              <span role="status" className={HINT}>
                {t('policy.saved')}
              </span>
            )}
          </div>
        </form>
      )}
      {error && (
        <p role="alert" className={ALERT}>
          {error}
        </p>
      )}
    </section>
  );
}
