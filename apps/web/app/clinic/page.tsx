'use client';

import { ApiError } from '@dhc/api-client';
import { PatientListResponse, TagList, type PatientSummary, type Tag } from '@dhc/contracts';
import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { AgeGender, TagChip } from './patient-bits';
import { useSession } from './session-provider';
import { PracticeCard } from './practice-card';
import { SettingsCard } from './settings-card';
import { ClinicShell, canRegister } from './shell';
import { StaffCard } from './staff-card';

/** Signed-in staff home: patient search and registration; admins also manage staff and settings. */
export default function ClinicDashboard() {
  return (
    <ClinicShell>
      {(me) =>
        me.role === 'patient' ? null : (
          <>
            <PatientSearch role={me.role} />
            {me.role === 'clinic_admin' && <StaffCard currentUserId={me.user.id} />}
            {me.role === 'clinic_admin' && <PracticeCard />}
            {me.role === 'clinic_admin' && <SettingsCard />}
          </>
        )
      }
    </ClinicShell>
  );
}

function PatientSearch({ role }: { role: string }) {
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
    <section aria-labelledby="patients-title" className="card">
      <div className="card-header">
        <h1 id="patients-title">{t('dashboard.searchPatients')}</h1>
        <div className="header-actions">
          <Link className="button-link secondary" href="/clinic/appointments">
            {t('dashboard.appointments')}
          </Link>
          <Link className="button-link secondary" href="/clinic/availability">
            {t('dashboard.availability')}
          </Link>
          {canRegister(role) && (
            <Link className="button-link" href="/clinic/patients/new">
              {t('dashboard.registerPatient')}
            </Link>
          )}
        </div>
      </div>
      <form className="search" onSubmit={submit} role="search">
        <label htmlFor="q" className="visually-hidden">
          {t('dashboard.searchPatients')}
        </label>
        <input
          id="q"
          name="q"
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t('dashboard.searchHint')}
        />
        {tags.length > 0 && (
          <>
            <label htmlFor="tag-filter" className="visually-hidden">
              {t('dashboard.filterTag')}
            </label>
            <select
              id="tag-filter"
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
            </select>
          </>
        )}
        <button type="submit">{t('common.search')}</button>
      </form>
      {error && (
        <p role="alert" className="alert">
          {error}
        </p>
      )}
      {patients && patients.length === 0 && <p>{t('dashboard.noPatients')}</p>}
      {patients && patients.length > 0 && (
        <table className="patients">
          <thead>
            <tr>
              <th scope="col">{t('patient.uhid')}</th>
              <th scope="col">{t('patient.name')}</th>
              <th scope="col">
                {t('patient.age')} · {t('patient.gender')}
              </th>
              <th scope="col">{t('patient.phone')}</th>
              <th scope="col">{t('patient.tags')}</th>
            </tr>
          </thead>
          <tbody>
            {patients.map((p) => (
              <tr key={p.id}>
                <td>{p.uhid}</td>
                <td>
                  <Link href={`/clinic/patients/${p.id}`}>{p.name}</Link>
                </td>
                <td>
                  <AgeGender patient={p} />
                </td>
                <td>{p.phone ?? '—'}</td>
                <td className="tags">
                  {p.tags.map((tag) => (
                    <TagChip key={tag.id} tag={tag} />
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
