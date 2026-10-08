'use client';

import { ApiError, createApiClient } from '@dhc/api-client';
import { PrescriptionCheck } from '@dhc/contracts';
import { formatIstDateTime } from '@dhc/domain';
import { t as translate, type Locale, type MessageKey } from '@dhc/i18n';
import { Button, cn } from '@dhc/ui-web';
import { CircleAlert, CircleCheck, CircleX } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

type State =
  | { kind: 'loading' }
  | { kind: 'notFound' }
  | { kind: 'error'; message: string }
  | { kind: 'found'; check: PrescriptionCheck };

const LOOK = {
  genuine: { icon: CircleCheck, box: 'bg-success-soft text-success' },
  superseded: { icon: CircleAlert, box: 'bg-warning-soft text-warning-foreground' },
  void: { icon: CircleX, box: 'bg-danger-soft text-destructive' },
} as const;

/** Checks the code with the API and shows what a pharmacist needs to match the paper. */
export function VerifyResult({ apiBaseUrl, code }: { apiBaseUrl: string; code: string }) {
  const api = useMemo(() => createApiClient({ baseUrl: apiBaseUrl }), [apiBaseUrl]);
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [locale, setLocale] = useState<Locale>('en');
  const t = (key: MessageKey, params?: Record<string, string | number>) =>
    translate(locale, key, params);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  useEffect(() => {
    let current = true;
    api
      .request('POST', '/verify', { schema: PrescriptionCheck, body: { code } })
      .then((check) => current && setState({ kind: 'found', check }))
      .catch((e) => {
        if (!current) return;
        if (e instanceof ApiError && (e.status === 404 || e.status === 400)) {
          setState({ kind: 'notFound' });
        } else {
          setState({ kind: 'error', message: e instanceof ApiError ? e.message : '' });
        }
      });
    return () => {
      current = false;
    };
  }, [api, code]);

  return (
    <div className="surface w-full max-w-lg space-y-5 p-6 sm:p-8" data-testid="verify-result">
      <div className="flex items-center justify-between gap-3">
        <h1 className="font-display text-2xl font-extrabold">{t('verify.title')}</h1>
        <Button
          type="button"
          variant="outline"
          size="sm"
          lang={locale === 'en' ? 'hi' : 'en'}
          onClick={() => setLocale(locale === 'en' ? 'hi' : 'en')}
        >
          {locale === 'en' ? 'हिन्दी' : 'English'}
        </Button>
      </div>
      {state.kind === 'loading' && (
        <p aria-live="polite" className="text-sm text-muted-foreground">
          {t('verify.checking')}
        </p>
      )}
      {state.kind === 'notFound' && (
        <p role="alert" className="rounded-xl bg-danger-soft px-4 py-3 text-sm text-destructive">
          {t('verify.notFound')}
        </p>
      )}
      {state.kind === 'error' && (
        <p role="alert" className="rounded-xl bg-danger-soft px-4 py-3 text-sm text-destructive">
          {state.message || t('error.network')}
        </p>
      )}
      {state.kind === 'found' && <Found check={state.check} locale={locale} t={t} />}
    </div>
  );
}

function Found({
  check,
  locale,
  t,
}: {
  check: PrescriptionCheck;
  locale: Locale;
  t: (key: MessageKey, params?: Record<string, string | number>) => string;
}) {
  const look = LOOK[check.status];
  const Icon = look.icon;
  const detail =
    check.status === 'genuine'
      ? t('verify.genuineDetail')
      : check.status === 'superseded'
        ? t('verify.supersededDetail', { version: check.latestVersion ?? check.version + 1 })
        : t('verify.voidDetail');
  const rows: [MessageKey, string][] = [
    ['verify.number', check.number],
    ['verify.version', String(check.version)],
    ['verify.signedAt', formatIstDateTime(check.signedAt, locale)],
    ['verify.doctor', [check.doctor.name, check.doctor.qualifications].filter(Boolean).join(', ')],
    [
      'verify.registration',
      [check.doctor.registrationNumber, check.doctor.council].filter(Boolean).join(', '),
    ],
    ['verify.clinic', check.clinicName],
    [
      'verify.patient',
      [
        check.patient.initials,
        check.patient.ageYears !== null
          ? t('pdf.ageYears', { years: check.patient.ageYears })
          : null,
        check.patient.gender ? t(`gender.${check.patient.gender}`) : null,
      ]
        .filter(Boolean)
        .join(' · '),
    ],
  ];
  return (
    <>
      <div className={cn('flex items-start gap-3 rounded-xl px-4 py-3', look.box)} role="status">
        <Icon aria-hidden className="mt-0.5 size-6 shrink-0" />
        <div>
          <p className="m-0 text-lg font-bold" data-testid="verify-status">
            {t(`verify.${check.status}`)}
          </p>
          <p className="m-0 text-sm">{detail}</p>
        </div>
      </div>
      {check.signatureMethod === 'test_key' && (
        <p className="text-sm font-medium text-destructive">{t('verify.testKey')}</p>
      )}
      <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        {rows.map(([key, value]) => (
          <div key={key} className="contents">
            <dt className="text-muted-foreground">{t(key)}</dt>
            <dd className="m-0 font-medium [overflow-wrap:anywhere]">{value || '—'}</dd>
          </div>
        ))}
      </dl>
      <div className="space-y-1.5 border-t border-border pt-4">
        <p className="m-0 text-sm text-muted-foreground">{t('verify.medicines')}</p>
        <ol className="m-0 list-decimal space-y-1 pl-5 text-sm">
          {check.medicines.map((m, i) => (
            <li key={i}>
              <span className="font-medium">{m.name}</span>
              {m.generic && (
                <span className="text-muted-foreground"> · {m.generic.toUpperCase()}</span>
              )}
            </li>
          ))}
        </ol>
      </div>
      <p className="text-xs text-muted-foreground">{t('verify.note')}</p>
    </>
  );
}
