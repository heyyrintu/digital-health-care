'use client';

import { ApiError } from '@dhc/api-client';
import {
  ClinicList,
  CreatedDisplayScreen,
  DisplayScreenList,
  type Clinic,
  type DisplayScreen,
} from '@dhc/contracts';
import { Button, Input, NativeSelect } from '@dhc/ui-web';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useSession } from './session-provider';

/**
 * Clinic admin: waiting-room screen links (PRD §5.3). A link is shown once; after that
 * only its name is listed, and it can be revoked.
 */
export function ScreensCard() {
  const { api, signOut, t } = useSession();
  const [screens, setScreens] = useState<DisplayScreen[] | null>(null);
  const [clinics, setClinics] = useState<Clinic[]>([]);
  const [created, setCreated] = useState<CreatedDisplayScreen | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handle = useCallback(
    (e: unknown) => {
      if (e instanceof ApiError && e.status === 401) return void signOut('expired');
      setError(e instanceof ApiError ? e.message : t('error.network'));
    },
    [signOut, t],
  );

  const load = useCallback(async () => {
    const [list, c] = await Promise.all([
      api.request('GET', '/display-screens', { schema: DisplayScreenList }),
      api.request('GET', '/clinics', { schema: ClinicList }),
    ]);
    setScreens(list.data);
    setClinics(c.data.filter((x) => x.active));
  }, [api]);

  useEffect(() => {
    load().catch(handle);
  }, [load, handle]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await load();
    } catch (e) {
      handle(e);
    } finally {
      setBusy(false);
    }
  }

  function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    void run(async () => {
      setCopied(false);
      setCreated(
        await api.request('POST', '/display-screens', {
          schema: CreatedDisplayScreen,
          body: { clinicId: String(data.get('clinicId')), label: String(data.get('label') ?? '') },
        }),
      );
      form.reset();
    });
  }

  const revoke = (s: DisplayScreen) =>
    run(async () => {
      await api.revokeDisplayScreen(s.id);
      if (created?.id === s.id) setCreated(null);
    });

  async function copy() {
    if (!created) return;
    await navigator.clipboard.writeText(created.link).catch(() => undefined);
    setCopied(true);
  }

  return (
    <section aria-labelledby="screens-title" className="surface p-4 sm:p-6">
      <h2 id="screens-title" className="font-display text-lg font-bold">
        {t('screens.title')}
      </h2>
      {screens && screens.length === 0 && (
        <p className="mt-3 text-sm text-muted-foreground">{t('screens.none')}</p>
      )}
      {screens && screens.length > 0 && (
        <ul className="mt-2 divide-y divide-border/70">
          {screens.map((s) => (
            <li
              key={s.id}
              data-testid={`screen-${s.label}`}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3"
            >
              <strong>{s.label}</strong>
              <span className="text-sm text-muted-foreground">{s.clinicName}</span>
              <Button
                type="button"
                variant="outline"
                className="ml-auto"
                disabled={busy}
                onClick={() => void revoke(s)}
              >
                {t('screens.revoke')}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {created && (
        <div className="mt-4 space-y-3 rounded-xl bg-info-soft p-4 text-sm" role="status">
          <p>{t('screens.linkHelp')}</p>
          <p className="flex flex-wrap items-center gap-3">
            <code
              data-testid="screen-link"
              className="min-w-0 flex-1 break-all rounded-lg bg-card px-3 py-2 font-mono text-xs"
            >
              {created.link}
            </code>{' '}
            <Button type="button" variant="outline" onClick={() => void copy()}>
              {copied ? t('screens.copied') : t('screens.copy')}
            </Button>
          </p>
        </div>
      )}
      {clinics.length > 0 && (
        <form className="mt-4 grid items-end gap-3 sm:grid-cols-2" onSubmit={add}>
          <div className="space-y-1.5">
            <label className="block text-sm font-medium" htmlFor="screen-label">
              {t('screens.label')}
            </label>
            <Input id="screen-label" name="label" required maxLength={60} />
          </div>
          <div className="space-y-1.5">
            <label className="block text-sm font-medium" htmlFor="screen-clinic">
              {t('screens.clinic')}
            </label>
            <NativeSelect id="screen-clinic" name="clinicId" defaultValue={clinics[0]?.id}>
              {clinics.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </NativeSelect>
          </div>
          <Button type="submit" disabled={busy} className="sm:col-span-2 sm:justify-self-start">
            {t('screens.add')}
          </Button>
        </form>
      )}
      {error && (
        <p
          role="alert"
          className="mt-3 rounded-xl bg-danger-soft px-4 py-3 text-sm font-medium text-destructive"
        >
          {error}
        </p>
      )}
    </section>
  );
}
