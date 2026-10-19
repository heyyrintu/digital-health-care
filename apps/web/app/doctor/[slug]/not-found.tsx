import { t } from '@dhc/i18n';
import { buttonVariants } from '@dhc/ui-web';
import Link from 'next/link';

/** Missing, unlisted and unverified doctors all land here: the same page for each. */
export default function DoctorNotFound() {
  return (
    <main className="flex min-h-dvh items-start justify-center bg-hero px-4 py-16">
      <div className="surface w-full max-w-lg space-y-3 p-6 text-center sm:p-8">
        <h1 className="font-display text-2xl font-extrabold">
          {t('en', 'doctorPage.notFoundTitle')}
        </h1>
        <p className="text-muted-foreground">{t('en', 'doctorPage.notFound')}</p>
        <p className="text-muted-foreground" lang="hi">
          {t('hi', 'doctorPage.notFound')}
        </p>
        <Link href="/" className={buttonVariants({ variant: 'outline' })}>
          {t('en', 'doctorPage.home')}
        </Link>
      </div>
    </main>
  );
}
