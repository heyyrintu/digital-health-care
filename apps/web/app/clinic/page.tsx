'use client';

import { ApiError } from '@dhc/api-client';
import { PatientListResponse, type PatientSummary } from '@dhc/contracts';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { LocaleToggle, useSession } from './session-provider';
import { StaffCard } from './staff-card';

/** Signed-in staff home. Patient search is the first real tool; the queue comes in Phase 1. */
export default function ClinicDashboard() {
  const { status, me, api, signOut, t } = useSession();
  const router = useRouter();
  const [patients, setPatients] = useState<PatientSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (status === 'signedOut') router.replace('/clinic/login');
  }, [status, router]);

  async function search(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const q = event ? String(new FormData(event.currentTarget).get('q') ?? '').trim() : '';
    setError(null);
    try {
      const result = await api.request('GET', '/patients', {
        schema: PatientListResponse,
        query: { limit: 50, q: q || undefined },
      });
      setPatients(result.data);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return void signOut('expired');
      setError(e instanceof ApiError ? e.message : t('error.network'));
    }
  }

  useEffect(() => {
    if (status === 'signedIn') void search();
    // Load the first page once signed in.
  }, [status]);

  if (status !== 'signedIn' || !me) {
    return (
      <main className="shell">
        <p aria-live="polite">{t('common.loading')}</p>
      </main>
    );
  }

  const name = me.user.displayName ?? me.user.email ?? me.user.phone ?? '';
  const isStaff = me.role !== 'patient';

  return (
    <main className="shell">
      <header className="dashboard-header">
        <div>
          <p className="eyebrow">{me.organisation.name}</p>
          <p data-testid="signed-in-as">
            {t('session.signedInAs', { name })} ·{' '}
            {isStaff ? t(`role.${me.role as 'doctor'}`) : me.role}
          </p>
        </div>
        <div className="header-actions">
          <LocaleToggle />
          <button type="button" className="secondary" onClick={() => void signOut('user')}>
            {t('session.signOut')}
          </button>
        </div>
      </header>

      {me.role === 'clinic_admin' && <StaffCard currentUserId={me.user.id} />}

      {isStaff && (
        <section aria-labelledby="patients-title" className="card">
          <h1 id="patients-title">{t('dashboard.searchPatients')}</h1>
          <form className="search" onSubmit={(e) => void search(e)} role="search">
            <label htmlFor="q" className="visually-hidden">
              {t('dashboard.searchPatients')}
            </label>
            <input id="q" name="q" type="search" placeholder={t('dashboard.searchHint')} />
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
                  <th scope="col">{t('patient.phone')}</th>
                  <th scope="col">{t('patient.dob')}</th>
                </tr>
              </thead>
              <tbody>
                {patients.map((p) => (
                  <tr key={p.id}>
                    <td>{p.uhid}</td>
                    <td>{p.name}</td>
                    <td>{p.phone ?? '—'}</td>
                    <td>{p.dob ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
    </main>
  );
}
