import { t } from '@dhc/i18n';
import { buttonVariants } from '@dhc/ui-web';
import Link from 'next/link';

export default function HomePage() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-hero px-4 py-12">
      <div className="w-full max-w-xl text-center">
        <p className="text-[11px] font-bold uppercase tracking-wide text-primary">
          Digital Healthcare Platform
        </p>
        <h1 className="mt-3 font-display text-3xl font-extrabold sm:text-4xl">
          {t('en', 'booking.book')}
        </h1>
        <p className="mx-auto mt-3 max-w-md text-muted-foreground">
          Public website placeholder. Doctor pages, booking and verification arrive in Phase 1.
        </p>
        <nav className="mt-8">
          <ul className="flex flex-col justify-center gap-3 sm:flex-row">
            <li>
              <Link href="/app" className={buttonVariants({ size: 'lg', className: 'w-full' })}>
                Patient portal
              </Link>
            </li>
            <li>
              <Link
                href="/clinic"
                className={buttonVariants({ variant: 'outline', size: 'lg', className: 'w-full' })}
              >
                Clinic dashboard
              </Link>
            </li>
          </ul>
        </nav>
      </div>
    </main>
  );
}
