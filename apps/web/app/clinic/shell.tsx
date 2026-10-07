'use client';

import type { MeResponse } from '@dhc/contracts';
import { useRouter } from 'next/navigation';
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

  useEffect(() => {
    if (status === 'signedOut') router.replace('/clinic/login');
  }, [status, router]);

  if (status !== 'signedIn' || !me) {
    return (
      <main className="shell">
        <p aria-live="polite">{t('common.loading')}</p>
      </main>
    );
  }

  const name = me.user.displayName ?? me.user.email ?? me.user.phone ?? '';
  return (
    <main className="shell">
      <header className="dashboard-header">
        <div>
          <p className="eyebrow">{me.organisation.name}</p>
          <p data-testid="signed-in-as">
            {t('session.signedInAs', { name })} ·{' '}
            {me.role === 'patient' ? me.role : t(`role.${me.role}`)}
          </p>
        </div>
        <div className="header-actions">
          <LocaleToggle />
          <button type="button" className="secondary" onClick={() => void signOut('user')}>
            {t('session.signOut')}
          </button>
        </div>
      </header>
      {children(me)}
    </main>
  );
}

/** Roles that may register and edit patients (PRD §3.2). */
export const canRegister = (role: string) =>
  role === 'front_desk' || role === 'doctor' || role === 'clinic_admin';

/** Roles that may assign tags (PRD §3.2: clinic admins configure, others assign). */
export const canTag = (role: string) => role === 'front_desk' || role === 'doctor';
