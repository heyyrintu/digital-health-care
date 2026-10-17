'use client';

import { ApiError } from '@dhc/api-client';
import type { PlatformOrganisation, StaffCounts } from '@dhc/contracts';
import { formatIstDateTime } from '@dhc/domain';
import { Badge, PageHeader, Surface } from '@dhc/ui-web';
import { useCallback, useEffect, useState } from 'react';
import { platformErrorKey } from '../../lib/platform';
import { OnboardCard } from './onboard-card';
import { usePlatformSession } from './session-provider';
import { ErrorNotice, PlatformShell } from './shell';

const TH = 'py-2 pr-3 text-left text-xs font-semibold text-muted-foreground';
const TD = 'py-2 pr-3 align-top';

/** Organisations with status, clinic and staff counts, and onboarding (PRD §9.1, §9.3). */
export default function OrganisationsPage() {
  return <PlatformShell>{() => <OrganisationsScreen />}</PlatformShell>;
}

function OrganisationsScreen() {
  const { api, locale, signOut, t } = usePlatformSession();
  const [organisations, setOrganisations] = useState<PlatformOrganisation[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** Reloads the list; failures are the caller's to show. */
  const refresh = useCallback(async () => {
    setOrganisations((await api.platform.organisations()).data);
  }, [api]);

  const load = useCallback(async () => {
    setError(null);
    try {
      await refresh();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return void signOut('expired');
      const key = platformErrorKey(e, 'page');
      setError(key ? t(key) : (e as Error).message);
    }
  }, [refresh, signOut, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const staff = (c: StaffCounts) =>
    t('platform.orgs.staffCount', { active: c.active, invited: c.invited });

  return (
    <section className="space-y-5">
      <PageHeader title={t('platform.orgs.title')} sub={t('platform.orgs.sub')} />
      <ErrorNotice message={error} />
      <OnboardCard onCreated={refresh} />

      <Surface className="min-w-0 p-4 sm:p-6">
        {!organisations ? (
          !error && (
            <p aria-live="polite" className="text-sm text-muted-foreground">
              {t('common.loading')}
            </p>
          )
        ) : organisations.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('platform.orgs.empty')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[56rem] text-sm" data-testid="organisations">
              <thead>
                <tr className="border-b border-border">
                  <th scope="col" className={TH}>
                    {t('platform.orgs.organisation')}
                  </th>
                  <th scope="col" className={TH}>
                    {t('platform.orgs.status')}
                  </th>
                  <th scope="col" className={TH}>
                    {t('platform.orgs.clinics')}
                  </th>
                  <th scope="col" className={TH}>
                    {t('platform.orgs.doctors')}
                  </th>
                  <th scope="col" className={TH}>
                    {t('platform.orgs.frontDesk')}
                  </th>
                  <th scope="col" className={TH}>
                    {t('platform.orgs.clinicAdmins')}
                  </th>
                  <th scope="col" className={TH}>
                    {t('platform.orgs.verification')}
                  </th>
                  <th scope="col" className={TH}>
                    {t('platform.orgs.created')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {organisations.map((o) => (
                  <tr
                    key={o.id}
                    data-testid={`org-${o.slug}`}
                    className="border-b border-border/60"
                  >
                    <th scope="row" className={`${TD} text-left font-normal`}>
                      <strong className="font-semibold">{o.name}</strong>
                      <span className="block text-xs text-muted-foreground">{o.slug}</span>
                    </th>
                    <td className={TD}>
                      <Badge variant={o.status === 'active' ? 'secondary' : 'destructive'}>
                        {t(`platform.orgs.status.${o.status}`)}
                      </Badge>
                    </td>
                    <td className={`${TD} tabular`}>
                      {t('platform.orgs.clinicCount', {
                        active: o.clinics.active,
                        total: o.clinics.total,
                      })}
                    </td>
                    <td className={`${TD} tabular`}>{staff(o.staff.doctor)}</td>
                    <td className={`${TD} tabular`}>{staff(o.staff.frontDesk)}</td>
                    <td className={`${TD} tabular`}>{staff(o.staff.clinicAdmin)}</td>
                    <td className={`${TD} tabular`}>
                      {t('platform.orgs.verificationCount', {
                        pending: o.doctorVerification.pending,
                        verified: o.doctorVerification.verified,
                      })}
                    </td>
                    <td className={`${TD} tabular text-muted-foreground`}>
                      {formatIstDateTime(o.createdAt, locale)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Surface>
    </section>
  );
}
