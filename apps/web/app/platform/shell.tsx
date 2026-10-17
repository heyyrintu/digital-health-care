'use client';

import type { PlatformOperator } from '@dhc/contracts';
import { Badge, StaffShell, type NavItem } from '@dhc/ui-web';
import { BadgeCheck, BarChart3, Building2 } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { PlatformLocaleToggle, usePlatformSession } from './session-provider';

/**
 * Signed-in console frame: the console's pages, who is signed in (name and email),
 * language and sign-out. Sends signed-out visitors to the console's own sign-in page and
 * renders children only once the session is ready.
 */
export function PlatformShell({
  children,
}: {
  children: (operator: PlatformOperator) => ReactNode;
}) {
  const { status, operator, signOut, t } = usePlatformSession();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (status === 'signedOut') router.replace('/platform/login');
  }, [status, router]);

  if (status !== 'signedIn' || !operator) {
    return (
      <main className="grid min-h-screen place-items-center bg-background p-4 font-sans text-muted-foreground">
        <p aria-live="polite">{t('common.loading')}</p>
      </main>
    );
  }

  const nav: NavItem[] = [
    { href: '/platform', label: t('platform.nav.organisations'), icon: Building2, exact: true },
    { href: '/platform/doctors', label: t('platform.nav.verification'), icon: BadgeCheck },
    { href: '/platform/usage', label: t('platform.nav.usage'), icon: BarChart3 },
  ];

  return (
    <StaffShell
      brand={{ name: t('platform.title'), letter: 'P' }}
      user={{ name: operator.displayName, detail: operator.email }}
      nav={nav}
      currentPath={pathname ?? '/platform'}
      onNavigate={(href) => router.push(href)}
      onSignOut={() => void signOut('user')}
      Link={Link}
      headerEnd={
        <>
          <PlatformLocaleToggle />
          <Badge variant="secondary" className="hidden sm:inline-flex">
            {t('platform.operator')}
          </Badge>
        </>
      }
    >
      <p data-testid="signed-in-as" className="mb-4 text-xs text-muted-foreground print:hidden">
        {t('platform.signedInAs', { name: operator.displayName, email: operator.email })}
      </p>
      {children(operator)}
    </StaffShell>
  );
}

/** A page's error notice, announced to screen readers. */
export function ErrorNotice({ message, id }: { message: string | null; id?: string }) {
  if (!message) return null;
  return (
    <p
      id={id}
      role="alert"
      className="rounded-xl bg-danger-soft px-4 py-3 text-sm font-medium text-destructive"
    >
      {message}
    </p>
  );
}
