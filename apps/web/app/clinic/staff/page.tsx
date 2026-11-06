'use client';
import { PageHeader } from '@dhc/ui-web';
import { ClinicShell, NotAllowed } from '../shell';
import { useSession } from '../session-provider';
import { PeopleDirectory } from './people-directory';
import { StaffCard } from '../staff-card';
export default function Page() {
  const { t } = useSession();
  return (
    <ClinicShell>
      {(me) =>
        me.role === 'clinic_admin' ? (
          <div className="mx-auto max-w-5xl space-y-6">
            <PageHeader title={t('identity.team')} />
            <p className="text-sm text-muted-foreground">{t('identity.inviteHint')}</p>
            <PeopleDirectory />
            <StaffCard currentUserId={me.user.id} />
          </div>
        ) : (
          <NotAllowed />
        )
      }
    </ClinicShell>
  );
}
