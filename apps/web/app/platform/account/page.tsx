'use client';
import { PageHeader } from '@dhc/ui-web';
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
      <PageHeader title={t('people.yourAccount')} />
      <SecuritySettings api={api} platform t={t} onChanged={() => signOut('user')} />
    </div>
  );
}
