'use client';

import type { PublicDoctor } from '@dhc/contracts';
import { formatInr } from '@dhc/domain';
import { t as translate, type Locale, type MessageKey } from '@dhc/i18n';
import { Button, buttonVariants, ModeIcon } from '@dhc/ui-web';
import { BadgeCheck, CalendarPlus, Languages, MapPin } from 'lucide-react';
import { useEffect, useState } from 'react';

/**
 * The page's visible part. Rendered in English on the server (what search engines and the
 * cache keep); `?lang=hi` or the toggle switch it to Hindi in the browser.
 */
export function DoctorProfileView({
  doctor,
  bookHref,
}: {
  doctor: PublicDoctor;
  bookHref: string;
}) {
  const [locale, setLocale] = useState<Locale>('en');
  const t = (key: MessageKey, params?: Record<string, string | number>) =>
    translate(locale, key, params);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('lang') === 'hi') setLocale('hi');
  }, []);
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const name = doctor.name ?? doctor.organisation.name;

  return (
    <article className="mx-auto w-full max-w-2xl space-y-5" data-testid="doctor-page">
      <div className="flex justify-end">
        <Button
          type="button"
          variant="outline"
          size="sm"
          lang={locale === 'en' ? 'hi' : 'en'}
          onClick={() => setLocale(locale === 'en' ? 'hi' : 'en')}
        >
          {locale === 'en' ? 'हिन्दी' : 'English'}
        </Button>
      </div>

      <header className="surface space-y-3 p-6 sm:p-8">
        <div className="flex items-start gap-4">
          <span
            aria-hidden
            className="grid size-14 shrink-0 place-items-center rounded-2xl bg-primary font-display text-2xl font-extrabold text-primary-foreground"
          >
            {name
              .replace(/^dr\.?\s*/i, '')
              .slice(0, 1)
              .toUpperCase()}
          </span>
          <div className="min-w-0 space-y-1">
            <h1 className="font-display text-2xl font-extrabold [overflow-wrap:anywhere] sm:text-3xl">
              {name}
            </h1>
            {doctor.qualifications && (
              <p className="m-0 font-medium text-muted-foreground">{doctor.qualifications}</p>
            )}
            {doctor.specialty && (
              <p className="m-0 text-sm font-semibold text-primary">{doctor.specialty}</p>
            )}
            <p className="m-0 text-sm text-muted-foreground">
              {t('doctorPage.at', { organisation: doctor.organisation.name })}
            </p>
          </div>
        </div>
        {doctor.registration.number && (
          <p
            className="m-0 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm"
            data-testid="registration"
          >
            <span className="text-muted-foreground">{t('doctorPage.registration')}:</span>
            <span className="font-medium [overflow-wrap:anywhere]">
              {doctor.registration.number}
            </span>
            {/* The platform team checked the number, not the rest of the profile. */}
            <span className="inline-flex items-center gap-1 rounded-full bg-success-soft px-2 py-0.5 text-xs font-semibold text-success">
              <BadgeCheck aria-hidden className="size-3.5 shrink-0" />
              {t('doctorPage.numberVerified')}
            </span>
            {doctor.registration.council && (
              <span className="text-muted-foreground [overflow-wrap:anywhere]">
                {doctor.registration.council}
              </span>
            )}
          </p>
        )}
        <a
          href={bookHref}
          className={buttonVariants({ size: 'lg', className: 'w-full sm:w-auto' })}
          data-testid="book-appointment"
        >
          <CalendarPlus aria-hidden />
          {t('doctorPage.book')}
        </a>
        <p className="m-0 text-xs text-muted-foreground">{t('doctorPage.bookHint')}</p>
      </header>

      {(doctor.about || doctor.languages.length > 0) && (
        <section className="surface space-y-4 p-6 sm:p-8" aria-labelledby="about-heading">
          {doctor.about && (
            <div className="space-y-2">
              <h2 id="about-heading" className="font-display text-lg font-bold">
                {t('doctorPage.about')}
              </h2>
              <p className="m-0 whitespace-pre-line text-sm leading-relaxed [overflow-wrap:anywhere]">
                {doctor.about}
              </p>
            </div>
          )}
          {doctor.languages.length > 0 && (
            <div className="space-y-2">
              <h2
                id={doctor.about ? undefined : 'about-heading'}
                className="flex items-center gap-2 font-display text-lg font-bold"
              >
                <Languages aria-hidden className="size-5" />
                {t('doctorPage.languages')}
              </h2>
              <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
                {doctor.languages.map((language) => (
                  <li
                    key={language}
                    className="rounded-full bg-muted px-3 py-1 text-sm font-medium"
                  >
                    {language}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      <section className="surface space-y-3 p-6 sm:p-8" aria-labelledby="fees-heading">
        <h2 id="fees-heading" className="font-display text-lg font-bold">
          {t('doctorPage.consultations')}
        </h2>
        {doctor.consultationTypes.length === 0 ? (
          <p className="m-0 text-sm text-muted-foreground">{t('doctorPage.noConsultations')}</p>
        ) : (
          <ul className="m-0 list-none divide-y divide-border p-0" data-testid="consultation-types">
            {doctor.consultationTypes.map((type, i) => (
              <li
                key={`${i}-${type.name}`}
                className="flex items-center justify-between gap-3 py-3"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <ModeIcon mode={type.mode} className="size-5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <p className="m-0 font-medium [overflow-wrap:anywhere]">{type.name}</p>
                    <p className="m-0 text-xs text-muted-foreground">
                      {t(`mode.${type.mode}`)} ·{' '}
                      {t('doctorPage.minutes', { minutes: type.durationMin })}
                    </p>
                  </div>
                </div>
                <p className="m-0 shrink-0 font-display font-bold">
                  {formatInr(type.feePaise, locale)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      {doctor.clinics.length > 0 && (
        <section className="surface space-y-3 p-6 sm:p-8" aria-labelledby="clinics-heading">
          <h2 id="clinics-heading" className="font-display text-lg font-bold">
            {t('doctorPage.clinics')}
          </h2>
          <ul className="m-0 list-none space-y-3 p-0">
            {doctor.clinics.map((clinic, i) => (
              <li key={`${i}-${clinic.name}`} className="flex items-start gap-3">
                <MapPin aria-hidden className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <p className="m-0 font-medium [overflow-wrap:anywhere]">{clinic.name}</p>
                  {clinic.address && (
                    <p className="m-0 whitespace-pre-line text-sm text-muted-foreground [overflow-wrap:anywhere]">
                      {clinic.address}
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </article>
  );
}
