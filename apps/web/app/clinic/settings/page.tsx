'use client';
import { PageHeader } from '@dhc/ui-web';
import { ClinicShell, NotAllowed } from '../shell';
import { useSession } from '../session-provider';
import { NameCard } from '../name-card';
import { PracticeCard } from '../practice-card';
import { BrandingCard } from '../branding-card';
import { SettingsCard } from '../settings-card';
import { PolicyCard } from '../policy-card';
import { PriceListCard } from '../price-list-card';
import { ScreensCard } from '../screens-card';
export default function Page() {
  const { t } = useSession();
  return (
    <ClinicShell>
      {(me) =>
        me.role === 'clinic_admin' ? (
          <div className="mx-auto max-w-5xl space-y-6">
            <PageHeader title={t('identity.settings')} />
            <NameCard organisation />
            <PracticeCard />
            <BrandingCard />
            <SettingsCard />
            <PolicyCard />
            <PriceListCard />
            <ScreensCard />
          </div>
        ) : (
          <NotAllowed />
        )
      }
    </ClinicShell>
  );
}
