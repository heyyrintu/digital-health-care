'use client';

import type { PublicDoctorCard } from '@dhc/contracts';
import { formatInr } from '@dhc/domain';
import type { Locale } from '@dhc/i18n';
import { buttonVariants, Field, Input, NativeSelect } from '@dhc/ui-web';
import { Languages, MapPin, Search, Stethoscope } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { doctorPath } from '../../lib/public-doctor';
import {
  cardName,
  cardPlaces,
  filterDirectory,
  specialtyOptions,
} from '../../lib/public-directory';
import { useHomeLocale } from './home-locale';

type Translate = ReturnType<typeof useHomeLocale>['t'];

/** What the platform is, in one line, and the two ways in. Needs no data, so it streams first. */
export function HomeHero() {
  const { t } = useHomeLocale();
  return (
    <header className="text-center">
      <p className="text-[11px] font-bold uppercase tracking-wide text-primary">
        {t('home.brand')}
      </p>
      <h1 className="mx-auto mt-3 max-w-xl font-display text-3xl font-extrabold sm:text-4xl">
        {t('home.headline')}
      </h1>
      <nav className="mt-8" aria-label={t('home.signInNav')}>
        <ul className="m-0 flex list-none flex-col justify-center gap-3 p-0 sm:flex-row">
          <li>
            <Link href="/app/login" className={buttonVariants({ size: 'lg', className: 'w-full' })}>
              {t('home.patientSignIn')}
            </Link>
          </li>
          <li>
            <Link
              href="/clinic/login"
              className={buttonVariants({ variant: 'outline', size: 'lg', className: 'w-full' })}
            >
              {t('home.clinicStaff')}
            </Link>
          </li>
        </ul>
      </nav>
    </header>
  );
}

/** The "Find a doctor" section's frame: heading, hint and whatever goes below. */
function DirectoryFrame({ children }: { children: ReactNode }) {
  const { t } = useHomeLocale();
  return (
    <section
      className="surface space-y-4 p-5 sm:p-8"
      aria-labelledby="find-doctor-heading"
      data-testid="doctor-directory"
    >
      <div className="space-y-1">
        <h2 id="find-doctor-heading" className="font-display text-2xl font-extrabold">
          {t('home.findDoctor')}
        </h2>
        <p className="m-0 text-sm text-muted-foreground">{t('home.findDoctorHint')}</p>
      </div>
      {children}
    </section>
  );
}

/** Shown while the server waits for the directory (at most three seconds). */
export function DirectoryLoading() {
  const { t } = useHomeLocale();
  return (
    <DirectoryFrame>
      <p className="m-0 text-sm text-muted-foreground" role="status">
        {t('home.loading')}
      </p>
    </DirectoryFrame>
  );
}

/** How long the count waits for typing to pause before it is announced (ms). */
const ANNOUNCE_DELAY_MS = 500;

/**
 * The directory: a search and a specialty filter over the list the server fetched (typing
 * never calls the API), the number of results, and the cards. `doctors` is null when the
 * API could not be reached in time.
 */
export function DirectorySection({ doctors }: { doctors: PublicDoctorCard[] | null }) {
  const { locale, t } = useHomeLocale();
  const [query, setQuery] = useState('');
  const [specialty, setSpecialty] = useState('');

  const specialties = useMemo(() => specialtyOptions(doctors ?? []), [doctors]);
  const shown = useMemo(
    () => filterDirectory(doctors ?? [], { query, specialty }),
    [doctors, query, specialty],
  );
  const filtering = query.trim() !== '' || specialty !== '';
  const countText =
    shown.length === 0 && filtering
      ? t('home.noMatch')
      : shown.length === 1
        ? t('home.countOne')
        : t('home.countMany', { count: shown.length });

  // The visible count changes at once; screen readers hear it once typing pauses.
  const [announced, setAnnounced] = useState(countText);
  useEffect(() => {
    const timer = setTimeout(() => setAnnounced(countText), ANNOUNCE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [countText]);

  if (doctors === null) {
    return (
      <DirectoryFrame>
        <p className="m-0 rounded-xl bg-muted p-4 text-sm" role="status">
          {t('home.unavailable')}
        </p>
      </DirectoryFrame>
    );
  }
  if (doctors.length === 0) {
    return (
      <DirectoryFrame>
        <p className="m-0 rounded-xl bg-muted p-4 text-sm">{t('home.empty')}</p>
      </DirectoryFrame>
    );
  }
  return (
    <DirectoryFrame>
      <form
        className="grid gap-3 sm:grid-cols-[1fr_14rem]"
        role="search"
        onSubmit={(e) => e.preventDefault()}
      >
        <Field label={t('home.search')}>
          <div className="relative">
            <Search
              aria-hidden
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('home.searchPlaceholder')}
              autoComplete="off"
              enterKeyHint="search"
              maxLength={100}
              className="pl-9"
            />
          </div>
        </Field>
        <Field label={t('home.specialty')}>
          <NativeSelect value={specialty} onChange={(e) => setSpecialty(e.target.value)}>
            <option value="">{t('home.allSpecialties')}</option>
            {specialties.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </NativeSelect>
        </Field>
      </form>

      {/* Hidden from screen readers: they get the announced copy below instead. */}
      <p
        className="m-0 text-sm font-medium text-muted-foreground"
        aria-hidden
        data-testid="directory-count"
      >
        {countText}
      </p>
      <p className="sr-only" role="status" aria-live="polite" data-testid="directory-count-live">
        {announced}
      </p>

      <ul className="m-0 grid list-none gap-3 p-0 sm:grid-cols-2" data-testid="doctor-cards">
        {shown.map((card) => (
          <li key={card.slug}>
            <DoctorCard card={card} locale={locale} t={t} />
          </li>
        ))}
      </ul>
    </DirectoryFrame>
  );
}

function DoctorCard({ card, locale, t }: { card: PublicDoctorCard; locale: Locale; t: Translate }) {
  const places = cardPlaces(card);
  // A plain link, not next/link: prefetching every visible card would render each doctor's
  // page (and call the API) just because the list scrolled past.
  const href = locale === 'hi' ? `${doctorPath(card.slug)}?lang=hi` : doctorPath(card.slug);
  return (
    <a
      href={href}
      aria-label={t('home.cardLabel', { name: cardName(card) })}
      className="block h-full rounded-2xl border border-border bg-card p-4 transition-colors hover:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      data-testid="doctor-card"
    >
      <p className="m-0 font-display text-lg font-bold [overflow-wrap:anywhere]">
        {cardName(card)}
      </p>
      {card.qualifications && (
        <p className="m-0 text-sm text-muted-foreground [overflow-wrap:anywhere]">
          {card.qualifications}
        </p>
      )}
      {card.specialty && (
        <p className="m-0 mt-1 flex items-center gap-1.5 text-sm font-semibold text-primary">
          <Stethoscope aria-hidden className="size-4 shrink-0" />
          <span className="[overflow-wrap:anywhere]">{card.specialty}</span>
        </p>
      )}
      <p className="m-0 mt-2 text-sm [overflow-wrap:anywhere]">
        {/* The clinic's display name only: the home page itself stays unbranded. */}
        {t('doctorPage.at', {
          organisation: card.organisationDisplayName ?? card.organisationName,
        })}
      </p>
      {places.length > 0 && (
        <ul className="m-0 mt-1 list-none space-y-0.5 p-0">
          {places.map((place, i) => (
            <li
              key={`${i}-${place}`}
              className="flex items-start gap-1.5 text-sm text-muted-foreground"
            >
              <MapPin aria-hidden className="mt-0.5 size-4 shrink-0" />
              <span className="[overflow-wrap:anywhere]">{place}</span>
            </li>
          ))}
        </ul>
      )}
      {card.languages.length > 0 && (
        <p className="m-0 mt-1 flex items-start gap-1.5 text-sm text-muted-foreground">
          <Languages aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span className="[overflow-wrap:anywhere]">{card.languages.join(', ')}</span>
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        {card.feeFromPaise !== null ? (
          <span className="font-display font-bold" data-testid="fee-from">
            {t('home.feeFrom', { fee: formatInr(card.feeFromPaise, locale) })}
          </span>
        ) : (
          <span />
        )}
        <span className="text-sm font-semibold text-primary">{t('home.viewProfile')}</span>
      </div>
    </a>
  );
}
