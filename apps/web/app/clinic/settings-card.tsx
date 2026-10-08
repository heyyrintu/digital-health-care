'use client';

import { ApiError } from '@dhc/api-client';
import { Tag, TagList, UhidSettings } from '@dhc/contracts';
import { Button, Input } from '@dhc/ui-web';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { TagChip } from './patient-bits';
import { useSession } from './session-provider';

const H3 = 'mb-3 mt-7 text-xs font-bold uppercase tracking-wide text-muted-foreground';
const ROW = 'flex flex-wrap items-center gap-x-3 gap-y-1 py-3';
const PILL = 'rounded-full bg-muted px-2.5 py-0.5 text-xs font-semibold text-muted-foreground';
const FORM = 'mt-4 grid items-end gap-3 sm:grid-cols-2';
const FIELD = 'space-y-1.5';
const LABEL = 'block text-sm font-medium';
const ALERT = 'mt-3 rounded-xl bg-danger-soft px-4 py-3 text-sm font-medium text-destructive';

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
    <section aria-labelledby="settings-title" className="surface p-4 sm:p-6">
      <h2 id="settings-title" className="font-display text-lg font-bold">
        {t('settings.title')}
      </h2>
      {error && (
        <p role="alert" className={ALERT}>
          {error}
        </p>
      )}

      <h3 className={H3}>{t('settings.uhidTitle')}</h3>
      {uhid && (
        <form className={FORM} onSubmit={saveUhid} aria-describedby="uhid-preview">
          <div className={FIELD}>
            <label className={LABEL} htmlFor="uhid-prefix">
              {t('settings.uhidPrefix')}
            </label>
            <Input
              id="uhid-prefix"
              name="prefix"
              defaultValue={uhid.prefix}
              maxLength={8}
              pattern="[A-Za-z0-9]*"
              autoCapitalize="characters"
            />
          </div>
          <div className={FIELD}>
            <label className={LABEL} htmlFor="uhid-next">
              {t('settings.uhidNext')}
            </label>
            <Input
              id="uhid-next"
              name="nextNumber"
              type="number"
              min={1}
              max={999999999}
              required
              defaultValue={uhid.nextNumber}
            />
          </div>
          <Button type="submit" disabled={busy} className="sm:col-span-2 sm:justify-self-start">
            {t('common.save')}
          </Button>
        </form>
      )}
      {uhid && (
        <p
          id="uhid-preview"
          className="mt-3 text-sm text-muted-foreground"
          data-testid="uhid-preview"
        >
          {t('settings.uhidPreview', { uhid: uhid.nextUhid })}
        </p>
      )}
      {uhidError && (
        <p role="alert" className={ALERT}>
          {uhidError}
        </p>
      )}

      <h3 className={H3}>{t('settings.tagsTitle')}</h3>
      {tags && tags.length === 0 && (
        <p className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
          {t('settings.noTags')}{' '}
          <Button type="button" variant="outline" disabled={busy} onClick={addDefaults}>
            {t('settings.addDefaults')}
          </Button>
        </p>
      )}
      {tags && tags.length > 0 && (
        <ul className="divide-y divide-border/70">
          {tags.map((tag) => (
            <li key={tag.id} data-testid={`tag-${tag.name}`} className={ROW}>
              <TagChip tag={tag} />
              {tag.sortToTop && (
                <span className="text-sm text-muted-foreground">{t('settings.sortsTop')}</span>
              )}
              {tag.archived && <span className={PILL}>{t('settings.archived')}</span>}
              <Button
                type="button"
                variant="outline"
                className="ml-auto"
                disabled={busy}
                onClick={() => void setArchived(tag, !tag.archived)}
              >
                {tag.archived ? t('settings.restore') : t('settings.archive')}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form className={FORM} onSubmit={addTag}>
        <div className={FIELD}>
          <label className={LABEL} htmlFor="tag-name">
            {t('settings.tagName')}
          </label>
          <Input id="tag-name" name="name" required maxLength={40} />
        </div>
        <div className={FIELD}>
          <label className={LABEL} htmlFor="tag-colour">
            {t('settings.tagColour')}
          </label>
          <Input
            id="tag-colour"
            name="colour"
            type="color"
            defaultValue="#475569"
            className="w-20 cursor-pointer p-1"
          />
        </div>
        <label className="flex min-h-11 items-center gap-2 text-sm sm:col-span-2">
          <input type="checkbox" name="sortToTop" className="size-4 accent-primary" />{' '}
          {t('settings.tagSortTop')}
        </label>
        <Button type="submit" disabled={busy} className="sm:col-span-2 sm:justify-self-start">
          {t('settings.addTag')}
        </Button>
      </form>
      {tagError && (
        <p role="alert" className={ALERT}>
          {tagError}
        </p>
      )}
    </section>
  );
}
