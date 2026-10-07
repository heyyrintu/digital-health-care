'use client';

import { ApiError } from '@dhc/api-client';
import { Tag, TagList, UhidSettings } from '@dhc/contracts';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { TagChip } from './patient-bits';
import { useSession } from './session-provider';

/** Clinic admin: UHID numbering and the patient tags staff can assign (PRD §5.4). */
export function SettingsCard() {
  const { api, signOut, t } = useSession();
  const [uhid, setUhid] = useState<UhidSettings | null>(null);
  const [tags, setTags] = useState<Tag[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uhidError, setUhidError] = useState<string | null>(null);
  const [tagError, setTagError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handle = useCallback(
    (e: unknown, show: (message: string) => void = setError) => {
      if (e instanceof ApiError && e.status === 401) return void signOut('expired');
      show(e instanceof ApiError ? e.message : t('error.network'));
    },
    [signOut, t],
  );

  const load = useCallback(async () => {
    try {
      const [settings, list] = await Promise.all([
        api.request('GET', '/uhid-settings', { schema: UhidSettings }),
        api.request('GET', '/tags', { schema: TagList }),
      ]);
      setUhid(settings);
      setTags(list.data);
    } catch (e) {
      handle(e);
    }
  }, [api, handle]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(action: () => Promise<void>, show?: (message: string) => void) {
    setBusy(true);
    setError(null);
    setUhidError(null);
    setTagError(null);
    try {
      await action();
    } catch (e) {
      handle(e, show);
    } finally {
      setBusy(false);
    }
  }

  function saveUhid(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void run(async () => {
      setUhid(
        await api.request('PUT', '/uhid-settings', {
          schema: UhidSettings,
          body: {
            prefix: String(data.get('prefix') ?? ''),
            nextNumber: Number(data.get('nextNumber')),
          },
        }),
      );
    }, setUhidError);
  }

  function addTag(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    void run(async () => {
      await api.request('POST', '/tags', {
        schema: Tag,
        body: {
          name: String(data.get('name') ?? ''),
          colour: String(data.get('colour') ?? '#475569'),
          sortToTop: data.get('sortToTop') === 'on',
        },
      });
      form.reset();
      await load();
    }, setTagError);
  }

  const setArchived = (tag: Tag, archived: boolean) =>
    run(async () => {
      await api.request('PATCH', `/tags/${tag.id}`, { schema: Tag, body: { archived } });
      await load();
    });

  const addDefaults = () =>
    run(async () => {
      setTags((await api.request('POST', '/tags/defaults', { schema: TagList })).data);
    });

  return (
    <section aria-labelledby="settings-title" className="card">
      <h2 id="settings-title">{t('settings.title')}</h2>
      {error && (
        <p role="alert" className="alert">
          {error}
        </p>
      )}

      <h3>{t('settings.uhidTitle')}</h3>
      {uhid && (
        <form className="inline-form" onSubmit={saveUhid} aria-describedby="uhid-preview">
          <div>
            <label htmlFor="uhid-prefix">{t('settings.uhidPrefix')}</label>
            <input
              id="uhid-prefix"
              name="prefix"
              defaultValue={uhid.prefix}
              maxLength={8}
              pattern="[A-Za-z0-9]*"
              autoCapitalize="characters"
            />
          </div>
          <div>
            <label htmlFor="uhid-next">{t('settings.uhidNext')}</label>
            <input
              id="uhid-next"
              name="nextNumber"
              type="number"
              min={1}
              max={999999999}
              required
              defaultValue={uhid.nextNumber}
            />
          </div>
          <button type="submit" disabled={busy}>
            {t('common.save')}
          </button>
        </form>
      )}
      {uhid && (
        <p id="uhid-preview" className="hint" data-testid="uhid-preview">
          {t('settings.uhidPreview', { uhid: uhid.nextUhid })}
        </p>
      )}
      {uhidError && (
        <p role="alert" className="alert">
          {uhidError}
        </p>
      )}

      <h3>{t('settings.tagsTitle')}</h3>
      {tags && tags.length === 0 && (
        <p>
          {t('settings.noTags')}{' '}
          <button type="button" className="secondary" disabled={busy} onClick={addDefaults}>
            {t('settings.addDefaults')}
          </button>
        </p>
      )}
      {tags && tags.length > 0 && (
        <ul className="tag-list">
          {tags.map((tag) => (
            <li key={tag.id} data-testid={`tag-${tag.name}`}>
              <TagChip tag={tag} />
              {tag.sortToTop && <span className="hint">{t('settings.sortsTop')}</span>}
              {tag.archived && <span className="pill">{t('settings.archived')}</span>}
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => void setArchived(tag, !tag.archived)}
              >
                {tag.archived ? t('settings.restore') : t('settings.archive')}
              </button>
            </li>
          ))}
        </ul>
      )}
      <form className="inline-form" onSubmit={addTag}>
        <div>
          <label htmlFor="tag-name">{t('settings.tagName')}</label>
          <input id="tag-name" name="name" required maxLength={40} />
        </div>
        <div className="narrow-field">
          <label htmlFor="tag-colour">{t('settings.tagColour')}</label>
          <input id="tag-colour" name="colour" type="color" defaultValue="#475569" />
        </div>
        <label className="checkbox">
          <input type="checkbox" name="sortToTop" /> {t('settings.tagSortTop')}
        </label>
        <button type="submit" disabled={busy}>
          {t('settings.addTag')}
        </button>
      </form>
      {tagError && (
        <p role="alert" className="alert">
          {tagError}
        </p>
      )}
    </section>
  );
}
