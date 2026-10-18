import type { PublicDoctor } from '@dhc/contracts';
import { t } from '@dhc/i18n';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { publicSiteUrl } from '../../../lib/config';
import { loadPublicDoctor as loadDoctor } from '../../../lib/public-doctor-server';
import {
  bookingHref,
  doctorDescription,
  doctorPath,
  jsonLdScript,
  physicianJsonLd,
} from '../../../lib/public-doctor';
import { DoctorProfileView } from './doctor-profile';

/**
 * Rendered on the server and kept for five minutes (ISR), so the CDN and the web server
 * answer most visits and the API sees at most one request per page per five minutes. A
 * doctor who unlists the page disappears within that time.
 */
export const revalidate = 300;

/** No page is built ahead: each is rendered on its first visit, then kept as above. */
export function generateStaticParams(): { slug: string }[] {
  return [];
}

type Props = { params: Promise<{ slug: string }> };

const titleOf = (doctor: PublicDoctor) =>
  [doctor.name ?? doctor.organisation.name, doctor.specialty].filter(Boolean).join(', ');

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const doctor = await loadDoctor(slug);
  if (!doctor) {
    return { title: t('en', 'doctorPage.notFoundTitle'), robots: { index: false, follow: false } };
  }
  const url = `${publicSiteUrl()}${doctorPath(doctor.slug)}`;
  const title = titleOf(doctor);
  const description = doctorDescription(doctor);
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: {
      type: 'profile',
      url,
      title,
      description,
      siteName: doctor.organisation.name,
      locale: 'en_IN',
    },
  };
}

/** A doctor's public page (Build Plan §5.1): profile, clinics, fees and booking. */
export default async function DoctorPage({ params }: Props) {
  const { slug } = await params;
  const doctor = await loadDoctor(slug);
  if (!doctor) notFound();
  const url = `${publicSiteUrl()}${doctorPath(doctor.slug)}`;
  return (
    <main className="min-h-dvh bg-hero px-4 py-8 sm:py-12">
      <script
        type="application/ld+json"
        data-testid="physician-json-ld"
        // Escaped JSON (no `<`), so nothing typed into the profile can end the tag.
        dangerouslySetInnerHTML={{ __html: jsonLdScript(physicianJsonLd(doctor, url)) }}
      />
      <DoctorProfileView doctor={doctor} bookHref={bookingHref(doctor)} />
    </main>
  );
}
