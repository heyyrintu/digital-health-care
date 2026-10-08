'use client';

import { ApiError } from '@dhc/api-client';
import { PatientListResponse, TagList, type PatientSummary, type Tag } from '@dhc/contracts';
import { Button, Input, NativeSelect, PageHeader } from '@dhc/ui-web';
import { Search } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { AgeGender, TagChip } from './patient-bits';
import { useSession } from './session-provider';
import { PracticeCard } from './practice-card';
import { PriceListCard } from './price-list-card';
import { ScreensCard } from './screens-card';
import { SettingsCard } from './settings-card';
import { ClinicShell } from './shell';
import { StaffCard } from './staff-card';

/** Signed-in staff home: patient search and registration; admins also manage staff and settings. */
export default function ClinicDashboard() {
  return (
    <ClinicShell>
      {(me) =>
        me.role === 'patient' ? null : (
          <div className="space-y-6">
            <PatientSearch />
            {me.role === 'clinic_admin' && (
              <div className="grid items-start gap-6 xl:grid-cols-2">
                <StaffCard currentUserId={me.user.id} />
                <PracticeCard />
                <PriceListCard />
                <ScreensCard />
                <SettingsCard />
              </div>
            )}
          </div>
        )
      }
    </ClinicShell>
  );
}

function PatientSearch() {
  const { api, signOut, t } = useSession();
  const [patients, setPatients] = useState<PatientSummary[] | null>(null);
  const [tags, setTags] = useState<Tag[]>([]);
  const [q, setQ] = useState('');
  const [tagId, setTagId] = useState('');
  const [error, setError] = useState<string | null>(null);

  const search = useCallback(
    async (query: string, tag: string) => {
      setError(null);
      try {
        const result = await api.request('GET', '/patients', {
          schema: PatientListResponse,
          query: { limit: 50, q: query || undefined, tagId: tag || undefined },
        });
        setPatients(result.data);
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return void signOut('expired');
        setError(e instanceof ApiError ? e.message : t('error.network'));
      }
    },
    [api, signOut, t],
  );

  useEffect(() => {
    void search('', '');
    api
      .request('GET', '/tags', { schema: TagList })
      .then((list) => setTags(list.data.filter((tag) => !tag.archived)))
      .catch(() => undefined);
  }, [api, search]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void search(q.trim(), tagId);
  }

  return (
    <>
      <PageHeader titleId="patients-title" title={t('dashboard.searchPatients')} />
      <section aria-labelledby="patients-title" className="surface p-4 sm:p-6">
        <form
          className="search flex flex-col gap-3 sm:flex-row sm:items-center"
          onSubmit={submit}
          role="search"
        >
          <label htmlFor="q" className="sr-only">
            {t('dashboard.searchPatients')}
          </label>
          <div className="relative min-w-0 flex-1">
            <Search
              className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              id="q"
              name="q"
              type="search"
              className="pl-10"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t('dashboard.searchHint')}
            />
          </div>
          {tags.length > 0 && (
            <>
              <label htmlFor="tag-filter" className="sr-only">
                {t('dashboard.filterTag')}
              </label>
              <NativeSelect
                id="tag-filter"
                className="sm:w-48"
                value={tagId}
                onChange={(e) => {
                  setTagId(e.target.value);
                  void search(q.trim(), e.target.value);
                }}
              >
                <option value="">{t('dashboard.allTags')}</option>
                {tags.map((tag) => (
                  <option key={tag.id} value={tag.id}>
                    {tag.name}
                  </option>
                ))}
              </NativeSelect>
            </>
          )}
          <Button type="submit">{t('common.search')}</Button>
        </form>
        {error && (
          <p
            role="alert"
            className="mt-4 rounded-xl bg-danger-soft px-4 py-3 text-sm font-medium text-destructive"
          >
            {error}
          </p>
        )}
        {patients && patients.length === 0 && (
          <p className="mt-6 text-sm text-muted-foreground">{t('dashboard.noPatients')}</p>
        )}
        {patients && patients.length > 0 && (
          <div className="-mx-4 mt-5 overflow-x-auto sm:mx-0">
            <table className="patients w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <th scope="col" className="px-4 py-3">
                    {t('patient.uhid')}
                  </th>
                  <th scope="col" className="px-4 py-3">
                    {t('patient.name')}
                  </th>
                  <th scope="col" className="px-4 py-3">
                    {t('patient.age')} · {t('patient.gender')}
                  </th>
                  <th scope="col" className="px-4 py-3">
                    {t('patient.phone')}
                  </th>
                  <th scope="col" className="px-4 py-3">
                    {t('patient.tags')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {patients.map((p) => (
                  <tr
                    key={p.id}
                    className="border-b border-border/70 transition-colors last:border-0 hover:bg-accent/60"
                  >
                    <td className="tabular px-4 py-3 text-muted-foreground">{p.uhid}</td>
                    <td className="px-4 py-3">
                      <Link
                        href={`/clinic/patients/${p.id}`}
                        className="inline-flex min-h-11 items-center font-semibold text-foreground hover:text-primary hover:underline"
                      >
                        {p.name}
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <AgeGender patient={p} />
                    </td>
                    <td className="tabular px-4 py-3">{p.phone ?? '—'}</td>
                    <td className="tags px-4 py-3">
                      <span className="flex flex-wrap gap-1.5">
                        {p.tags.map((tag) => (
                          <TagChip key={tag.id} tag={tag} />
                        ))}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
