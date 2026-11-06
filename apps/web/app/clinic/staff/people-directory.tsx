'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ApiError } from '@dhc/api-client';
import { PeopleList, type PeoplePerson } from '@dhc/contracts';
import { Button, Input, Field, Surface } from '@dhc/ui-web';
import { useSession } from '../session-provider';
export function PeopleDirectory() {
  const { api, t, signOut } = useSession();
  const [rows, setRows] = useState<PeoplePerson[]>([]),
    [query, setQuery] = useState(''),
    [activeQuery, setActiveQuery] = useState(''),
    [cursor, setCursor] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const load = useCallback(
    async (q: string, next?: string) => {
      setBusy(true);
      setError('');
      try {
        const result = await api.request('GET', '/staff/people', {
          schema: PeopleList,
          query: { q: q || undefined, cursor: next },
        });
        setRows((old) => (next ? [...old, ...result.data] : result.data));
        setCursor(result.nextCursor);
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) void signOut('expired');
        else setError(e instanceof Error ? e.message : t('error.network'));
      } finally {
        setBusy(false);
      }
    },
    [api, signOut, t],
  );
  useEffect(() => {
    void load('');
  }, [load]);
  function search(e: FormEvent) {
    e.preventDefault();
    setActiveQuery(query);
    void load(query);
  }
  return (
    <Surface className="space-y-4 p-5 sm:p-6">
      <h2 className="font-display text-xl font-bold">{t('people.directory')}</h2>
      <form className="flex flex-wrap items-end gap-3" onSubmit={search}>
        <Field label={t('people.search')}>
          <Input value={query} onChange={(e) => setQuery(e.target.value)} maxLength={120} />
        </Field>
        <Button disabled={busy} type="submit">
          {t('people.searchButton')}
        </Button>
      </form>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {!rows.length && !busy && !error && <p>{t('people.empty')}</p>}
      <ul className="divide-y divide-border">
        {rows.map((person) => (
          <li
            key={person.userId}
            className="flex flex-wrap items-center justify-between gap-3 py-4"
          >
            <div>
              <Link
                className="font-semibold text-primary underline"
                href={`/clinic/staff/${person.userId}`}
              >
                {person.displayName ?? person.email ?? person.phone}
              </Link>
              <p className="text-sm text-muted-foreground">
                {person.email ?? person.phone} ·{' '}
                {person.roles.map((role) => t(`role.${role}`)).join(', ')}
              </p>
            </div>
            <span className="rounded-full bg-muted px-3 py-1 text-sm">
              {t(`people.status.${person.status}`)}
            </span>
          </li>
        ))}
      </ul>
      {cursor && (
        <Button variant="outline" disabled={busy} onClick={() => void load(activeQuery, cursor)}>
          {t('people.loadMore')}
        </Button>
      )}
      {busy && <p role="status">{t('common.loading')}</p>}
    </Surface>
  );
}
