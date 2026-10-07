import { t } from '@dhc/i18n';
import type { Metadata } from 'next';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Waiting room',
  robots: { index: false, follow: false },
};

/** Waiting-room display: current and next tokens only, never patient names. */
export default async function DisplayPage({ params }: PageProps<'/display/[clinic]'>) {
  await params;
  return (
    <main className="display">
      <div>
        <p>{t('en', 'queue.nowServing')}</p>
        <p className="token">—</p>
        <p>{t('en', 'queue.next')}: —</p>
      </div>
    </main>
  );
}
