'use client';

import { t } from '@dhc/i18n';
import { Button } from '@dhc/ui-web';

/**
 * Shown when the page could not be built: the API is busy (429) or unreachable. Nothing is
 * cached for it, so trying again a little later works. English and Hindi together, since
 * the page's own language toggle is not there.
 */
export default function DoctorPageError({ reset }: { reset: () => void }) {
  return (
    <main className="flex min-h-dvh items-start justify-center bg-hero px-4 py-16">
      <div className="surface w-full max-w-lg space-y-3 p-6 text-center sm:p-8" role="alert">
        <h1 className="font-display text-2xl font-extrabold">{t('en', 'doctorPage.busyTitle')}</h1>
        <p className="text-muted-foreground">{t('en', 'doctorPage.busy')}</p>
        <p className="text-muted-foreground" lang="hi">
          {t('hi', 'doctorPage.busy')}
        </p>
        <Button type="button" variant="outline" onClick={() => reset()}>
          {t('en', 'doctorPage.retry')} / <span lang="hi">{t('hi', 'doctorPage.retry')}</span>
        </Button>
      </div>
    </main>
  );
}
