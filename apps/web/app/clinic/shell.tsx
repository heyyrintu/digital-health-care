'use client';

import type { MeResponse } from '@dhc/contracts';
import { Badge, StaffShell, type NavItem } from '@dhc/ui-web';
import { CalendarClock, IndianRupee, ListOrdered, UserPlus, Users } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { LocaleToggle, useSession } from './session-provider';

/**
 * Signed-in staff page frame: clinic name, who is signed in, language and sign-out.
 * Sends signed-out visitors to the sign-in page and renders children only once the
 * session is ready.
 */
export function ClinicShell({ children }: { children: (me: MeResponse) => ReactNode }) {
  const { status, me, signOut, t } = useSession();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (status === 'signedOut') router.replace('/clinic/login');
  }, [status, router]);

  if (status !== 'signedIn' || !me) {
    return (
      <main className="grid min-h-screen place-items-center bg-background p-4 font-sans text-muted-foreground">
        <p aria-live="polite">{t('common.loading')}</p>
      </main>
    );
  }

  const name = me.user.displayName ?? me.user.email ?? me.user.phone ?? '';
  const roleLabel = me.role === 'patient' ? me.role : t(`role.${me.role}`);
  const orgName = me.organisation.name;

  // Mirrors the links the dashboard used to offer: every staff role sees the queue and
  // availability; only roles that may register patients get the registration link.
  const nav: NavItem[] =
    me.role === 'patient'
      ? []
      : [
          { href: '/clinic', label: t('dashboard.searchPatients'), icon: Users, exact: true },
          { href: '/clinic/queue', label: t('dashboard.queue'), icon: ListOrdered },
          { href: '/clinic/availability', label: t('dashboard.availability'), icon: CalendarClock },
          { href: '/clinic/collections', label: t('dashboard.collections'), icon: IndianRupee },
          ...(canRegister(me.role)
            ? [
                {
                  href: '/clinic/patients/new',
                  label: t('dashboard.registerPatient'),
                  icon: UserPlus,
                },
              ]
            : []),
        ];

  return (
    <StaffShell
      brand={{ name: orgName, letter: orgName.charAt(0).toUpperCase() }}
      user={{ name, detail: roleLabel }}
      nav={nav}
      currentPath={pathname ?? '/clinic'}
      onNavigate={(href) => router.push(href)}
      onSignOut={() => void signOut('user')}
      Link={Link}
      headerEnd={
        <>
          <LocaleToggle />
          <Badge variant="secondary" className="hidden sm:inline-flex">
            {roleLabel}
          </Badge>
        </>
      }
    >
      <p data-testid="signed-in-as" className="mb-4 text-xs text-muted-foreground print:hidden">
        {t('session.signedInAs', { name })} ·{' '}
        {me.role === 'patient' ? me.role : t(`role.${me.role}`)}
      </p>
      {children(me)}
    </StaffShell>
  );
}

/** Roles that may register and edit patients (PRD §3.2). */
export const canRegister = (role: string) =>
  role === 'front_desk' || role === 'doctor' || role === 'clinic_admin';

/** Roles that may assign tags (PRD §3.2: clinic admins configure, others assign). */
export const canTag = (role: string) => role === 'front_desk' || role === 'doctor';
