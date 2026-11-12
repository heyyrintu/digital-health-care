'use client';
import { PlatformShell } from '../shell';
import { usePlatformSession } from '../session-provider';
import { SecuritySettings } from '../../../components/account-security/settings';
export default function Page() {
  return <PlatformShell>{() => <Account />}</PlatformShell>;
}
function Account() {
  const { api, t, signOut } = usePlatformSession();
  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="mb-5 font-display text-2xl font-bold">{t('people.yourAccount')}</h1>
      <SecuritySettings api={api} platform t={t} onChanged={() => signOut('user')} />
    </div>
  );
}
