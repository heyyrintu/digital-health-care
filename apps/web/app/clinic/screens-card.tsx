'use client';

import { ApiError } from '@dhc/api-client';
import {
  ClinicList,
  CreatedDisplayScreen,
  DisplayScreenList,
  type Clinic,
  type DisplayScreen,
} from '@dhc/contracts';
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
    <section aria-labelledby="screens-title" className="card">
      <h2 id="screens-title">{t('screens.title')}</h2>
      {screens && screens.length === 0 && <p>{t('screens.none')}</p>}
      {screens && screens.length > 0 && (
        <ul className="tag-list">
          {screens.map((s) => (
            <li key={s.id} data-testid={`screen-${s.label}`}>
              <strong>{s.label}</strong>
              <span className="hint">{s.clinicName}</span>
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => void revoke(s)}
              >
                {t('screens.revoke')}
              </button>
            </li>
          ))}
        </ul>
      )}
      {created && (
        <div className="notice" role="status">
          <p>{t('screens.linkHelp')}</p>
          <p className="link-box">
            <code data-testid="screen-link">{created.link}</code>{' '}
            <button type="button" className="secondary" onClick={() => void copy()}>
              {copied ? t('screens.copied') : t('screens.copy')}
            </button>
          </p>
        </div>
      )}
      {clinics.length > 0 && (
        <form className="inline-form" onSubmit={add}>
          <div>
            <label htmlFor="screen-label">{t('screens.label')}</label>
            <input id="screen-label" name="label" required maxLength={60} />
          </div>
          <div>
            <label htmlFor="screen-clinic">{t('screens.clinic')}</label>
            <select id="screen-clinic" name="clinicId" defaultValue={clinics[0]?.id}>
              {clinics.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <button type="submit" disabled={busy}>
            {t('screens.add')}
          </button>
        </form>
      )}
      {error && (
        <p role="alert" className="alert">
          {error}
        </p>
      )}
    </section>
  );
}
