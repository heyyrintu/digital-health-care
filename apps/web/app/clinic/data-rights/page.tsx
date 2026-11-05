'use client';
import { RightsQueue } from '../../../components/data-rights';
import { useSession } from '../session-provider';
import { ClinicShell, NotAllowed } from '../shell';
export default function Page() {
  return (
    <ClinicShell>
      {(me) =>
        me.role === 'clinic_admin' || me.role === 'doctor' ? (
          <Centre role={me.role} />
        ) : (
          <NotAllowed />
        )
      }
    </ClinicShell>
  );
}
function Centre({ role }: { role: 'clinic_admin' | 'doctor' }) {
  const { api, t } = useSession();
  return (
    <div className="space-y-6">
      <h1 className="font-display text-2xl font-bold">{t('dataRights.title')}</h1>
      <p>{t('dataRights.staffHelp')}</p>
      <RightsQueue api={api} t={t} role={role} />
    </div>
  );
}
