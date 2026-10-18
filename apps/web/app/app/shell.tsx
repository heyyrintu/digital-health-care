'use client';

import type { PatientAccountState } from '@dhc/api-client';
import type { MeResponse, PortalPatient } from '@dhc/contracts';
import { Button, cn, Surface } from '@dhc/ui-web';
import {
  CalendarDays,
  CalendarPlus,
  FileText,
  FlaskConical,
  Home,
  LogOut,
  Users,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { ConsentsStep } from './consents';
import { LoadError, Loading, PortalPage } from './parts';
import { PatientForm } from './patient-form';
import { PatientLocaleToggle, usePatientSession } from './session-provider';

export interface ReadyAccount {
  me: MeResponse;
  patients: PortalPatient[];
  /** Whose records the pages show; chosen on the home page. */
  selected: PortalPatient;
  select(patientId: string): void;
}

/** The account store's state, loaded once per sign-in. */
function useAccount(enabled: boolean): PatientAccountState {
  const { account } = usePatientSession();
  const state = useSyncExternalStore(account.subscribe, account.getState, account.getState);
  useEffect(() => {
    if (enabled) void account.ensureLoaded();
  }, [account, enabled]);
  return state;
}

/**
 * Signed-in portal frame: the clinic's name, the pages, language and sign-out, phone first.
 * Sends signed-out visitors to sign-in. Every page sits behind onboarding (as in the
 * Patient app): the consents first, then the person's own record when the clinic has none
 * on this number; only then does the page get the family.
 */
export function PortalShell({ children }: { children: (account: ReadyAccount) => ReactNode }) {
  const { status, me, account, signOut, t } = usePatientSession();
  const router = useRouter();
  const state = useAccount(status === 'signedIn');

  useEffect(() => {
    if (status === 'signedOut') router.replace('/app/login');
  }, [status, router]);

  if (status !== 'signedIn' || !me) {
    return (
      <main className="grid min-h-dvh place-items-center bg-background p-4 font-sans text-muted-foreground">
        <p aria-live="polite">{t('common.loading')}</p>
      </main>
    );
  }

  let body: ReactNode;
  switch (state.status) {
    case 'loading':
      body = <Loading />;
      break;
    case 'error':
      body = <LoadError error={state.error} retry={() => void account.reload()} />;
      break;
    case 'consents':
      body = <ConsentsStep status={state.consents} />;
      break;
    case 'profile':
      body = (
        <PortalPage title={t('patient.profile.title')} intro={t('patient.profile.intro')}>
          <Surface className="p-5 sm:p-6">
            <PatientForm submitLabel={t('patient.profile.save')} onSaved={() => account.reload()} />
          </Surface>
        </PortalPage>
      );
      break;
    case 'ready': {
      const selected = state.patients.find((p) => p.id === state.selectedId)!;
      body = children({
        me,
        patients: state.patients,
        selected,
        select: (id) => account.select(id),
      });
      break;
    }
  }

  return (
    <div className="min-h-dvh bg-background font-sans text-foreground">
      <header className="sticky top-0 z-10 border-b bg-card/95 backdrop-blur print:hidden">
        <div className="mx-auto flex max-w-2xl items-center gap-3 px-4 py-2.5">
          <span
            className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-primary font-display font-bold text-primary-foreground"
            aria-hidden
          >
            {me.organisation.name.slice(0, 1).toUpperCase()}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate font-display text-sm font-bold">{me.organisation.name}</p>
            <p data-testid="signed-in-as" className="truncate text-xs text-muted-foreground">
              {t('portal.signedInAs', { phone: me.user.phone ?? '' })}
            </p>
          </div>
          <PatientLocaleToggle />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void signOut('user')}
            aria-label={t('session.signOut')}
          >
            <LogOut aria-hidden />
            <span className="hidden sm:inline">{t('session.signOut')}</span>
          </Button>
        </div>
        {state.status === 'ready' && <PortalNav />}
      </header>
      <main className="mx-auto max-w-2xl px-4 py-6 sm:py-8">{body}</main>
    </div>
  );
}

/** The portal's pages; a row of tabs that scrolls sideways on narrow phones. */
function PortalNav() {
  const { t } = usePatientSession();
  const pathname = usePathname() ?? '/app';
  const items = [
    { href: '/app', label: t('portal.nav.home'), icon: Home, exact: true },
    { href: '/app/appointments', label: t('patient.nav.appointments'), icon: CalendarDays },
    { href: '/app/book', label: t('booking.book'), icon: CalendarPlus },
    { href: '/app/prescriptions', label: t('patient.nav.prescriptions'), icon: FileText },
    { href: '/app/tests', label: t('patient.nav.tests'), icon: FlaskConical },
    { href: '/app/family', label: t('patient.nav.family'), icon: Users },
  ];
  return (
    <nav aria-label={t('portal.title')} className="mx-auto max-w-2xl">
      <ul className="scrollbar-none flex gap-1 overflow-x-auto px-2 pb-1.5">
        {items.map(({ href, label, icon: Icon, exact }) => {
          const current = exact ? pathname === href : pathname.startsWith(href);
          return (
            <li key={href} className="shrink-0">
              <Link
                href={href}
                aria-current={current ? 'page' : undefined}
                className={cn(
                  'flex min-h-11 items-center gap-1.5 rounded-lg px-3 text-sm font-semibold transition',
                  current
                    ? 'bg-accent text-primary'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                )}
              >
                <Icon className="size-4" aria-hidden />
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
