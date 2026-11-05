'use client';

import { ApiError, type ApiClient } from '@dhc/api-client';
import { WhatsAppPreference } from '@dhc/contracts';
import type { MessageKey } from '@dhc/i18n';
import { Button, Surface } from '@dhc/ui-web';
import { useCallback, useEffect, useId, useRef, useState } from 'react';

export function WhatsAppPreferenceCard({
  api,
  category = 'appointments',
  path,
  t,
  staff = false,
  revokeOnly = false,
  onExpired,
}: {
  api: ApiClient;
  category?: 'appointments' | 'records' | 'payments';
  path: string;
  staff?: boolean;
  revokeOnly?: boolean;
  t: (key: MessageKey, params?: Record<string, string | number>) => string;
  onExpired: () => void;
}) {
  const label = (key: MessageKey, params?: Record<string, string | number>) =>
    t(
      category === 'payments'
        ? (key.replace('whatsapp.preference.', 'whatsapp.payments.') as MessageKey)
        : category === 'records'
          ? (key.replace('whatsapp.preference.', 'whatsapp.records.') as MessageKey)
          : key,
      params,
    );
  const [value, setValue] = useState<WhatsAppPreference | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0),
    checkboxId = useId();
  const fail = useCallback(
    (e: unknown) => {
      if (e instanceof ApiError && e.status === 401) return onExpired();
      setError(e instanceof ApiError ? e.message : t('error.network'));
    },
    [onExpired, t],
  );
  useEffect(() => {
    const current = ++generation.current;
    setBusy(false);
    setValue(null);
    setAgreed(false);
    setError(null);
    api
      .request('GET', path, { schema: WhatsAppPreference })
      .then((v) => {
        if (current === generation.current) setValue(v);
      })
      .catch((e: unknown) => {
        if (current === generation.current) fail(e);
      });
    return () => {
      ++generation.current;
    };
  }, [api, path, fail, reload]);

  async function save(enabled: boolean) {
    const current = generation.current;
    setBusy(true);
    setError(null);
    try {
      const v = await api.request('PUT', path, {
        schema: WhatsAppPreference,
        body: { enabled, recipientAgreed: agreed },
      });
      if (current === generation.current) {
        setValue(v);
        setAgreed(false);
      }
    } catch (e) {
      if (current === generation.current) fail(e);
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }
  if (revokeOnly && !error && !value?.enabled) return null;
  return (
    <Surface
      className="space-y-3 p-4"
      data-testid={
        category === 'payments'
          ? 'whatsapp-payment-preference'
          : category === 'records'
            ? 'whatsapp-record-preference'
            : 'whatsapp-preference'
      }
    >
      <h2 className="font-display text-lg font-bold">{label('whatsapp.preference.title')}</h2>
      <p className="text-sm text-muted-foreground">{label('whatsapp.preference.description')}</p>
      {error && (
        <div className="space-y-2">
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
          <Button variant="outline" onClick={() => setReload((v) => v + 1)}>
            {label('common.retry')}
          </Button>
        </div>
      )}
      {!value && !error && <p aria-live="polite">{label('common.loading')}</p>}
      {value && (
        <>
          {value.phoneLast4 && (
            <p className="text-sm">
              {label('whatsapp.preference.number', { last4: value.phoneLast4 })}
            </p>
          )}
          <p role="status" className="text-sm font-medium">
            {label(value.enabled ? 'whatsapp.preference.on' : 'whatsapp.preference.off')}
          </p>
          {!value.available && (
            <p className="text-sm text-muted-foreground">
              {label(
                value.phoneLast4
                  ? 'whatsapp.preference.unavailable'
                  : 'whatsapp.preference.noPhone',
              )}
            </p>
          )}
          {!value.enabled && value.available && (
            <label htmlFor={checkboxId} className="flex items-start gap-3 text-sm">
              <input
                id={checkboxId}
                type="checkbox"
                checked={agreed}
                disabled={busy}
                onChange={(e) => setAgreed(e.target.checked)}
                className="mt-1 h-4 w-4"
              />
              {label(
                staff ? 'whatsapp.preference.staffAgreement' : 'whatsapp.preference.myAgreement',
              )}
            </label>
          )}
          {value.enabled ? (
            <Button variant="outline" disabled={busy} onClick={() => void save(false)}>
              {label('whatsapp.preference.disable')}
            </Button>
          ) : (
            <Button disabled={busy || !agreed || !value.available} onClick={() => void save(true)}>
              {label('whatsapp.preference.enable')}
            </Button>
          )}
        </>
      )}
    </Surface>
  );
}
