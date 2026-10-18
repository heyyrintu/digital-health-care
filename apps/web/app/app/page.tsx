'use client';

import type { PortalAppointmentList } from '@dhc/contracts';
import { shortDate } from '@dhc/domain';
import { Button, Surface } from '@dhc/ui-web';
import { CalendarDays, CalendarPlus, ChevronRight, ShieldCheck, Users } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { nextAppointmentFor } from '../../lib/patient';
import { LoadError, Loading, PatientPicker, PortalPage } from './parts';
import { usePatientSession } from './session-provider';
import { PortalShell, type ReadyAccount } from './shell';

/** PRD §4.2: patient switcher, next appointment and the portal's pages. */
export default function PortalHomePage() {
  return <PortalShell>{(account) => <Home account={account} />}</PortalShell>;
}

function Home({ account }: { account: ReadyAccount }) {
  const { api, locale, t } = usePatientSession();
  const [list, setList] = useState<
    | { status: 'loading' }
    | { status: 'error'; error: unknown }
    | { status: 'ready'; data: PortalAppointmentList }
  >({ status: 'loading' });

  const load = useCallback(() => {
    setList({ status: 'loading' });
    api
      .portalAppointments()
      .then((data) => setList({ status: 'ready', data }))
      .catch((error: unknown) => setList({ status: 'error', error }));
  }, [api]);
  useEffect(load, [load]);

  const { selected } = account;
  const next = list.status === 'ready' ? nextAppointmentFor(list.data, selected.id) : undefined;

  const links = [
    { href: '/app/appointments', label: t('patient.nav.appointments'), icon: CalendarDays },
    { href: '/app/family', label: t('patient.nav.family'), icon: Users },
    { href: '/app/privacy', label: t('patient.nav.privacy'), icon: ShieldCheck },
  ];

  return (
    <PortalPage title={t('portal.welcome', { name: selected.name })}>
      <PatientPicker
        label={t('patient.home.switcher')}
        patients={account.patients}
        selectedId={selected.id}
        onSelect={account.select}
      />

      <Surface className="space-y-4 p-5 sm:p-6" data-testid="next-appointment">
        <h2 className="font-display text-lg font-bold">{t('patient.home.next')}</h2>
        {list.status === 'loading' && <Loading />}
        {list.status === 'error' && <LoadError error={list.error} retry={load} />}
        {list.status === 'ready' &&
          (next ? (
            <div className="space-y-1 text-sm">
              <p className="font-semibold">
                {shortDate(next.date, locale)} · <span className="tabular">{next.startTime}</span>
              </p>
              <p className="text-muted-foreground">
                {next.doctorName
                  ? t('patient.home.with', { doctor: next.doctorName, clinic: next.clinicName })
                  : next.clinicName}
              </p>
              <p className="text-muted-foreground">
                {t('queue.token', { token: next.tokenNumber })} · {t(`status.${next.status}`)}
              </p>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{t('patient.home.noNext')}</p>
          ))}
        <Button asChild className="w-full sm:w-auto">
          <Link href="/app/book">
            <CalendarPlus aria-hidden />
            {t('booking.book')}
          </Link>
        </Button>
      </Surface>

      <ul className="surface divide-y overflow-hidden">
        {links.map(({ href, label, icon: Icon }) => (
          <li key={href}>
            <Link
              href={href}
              className="flex min-h-14 items-center gap-3 px-5 text-sm font-semibold transition hover:bg-accent"
            >
              <Icon className="size-5 text-primary" aria-hidden />
              <span className="flex-1">{label}</span>
              <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
            </Link>
          </li>
        ))}
      </ul>
    </PortalPage>
  );
}
