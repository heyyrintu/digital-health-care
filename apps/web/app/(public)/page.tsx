import { t } from '@dhc/i18n';
import type { Metadata } from 'next';
import { Suspense } from 'react';
import { publicSiteUrl } from '../../lib/config';
import { jsonLdScript } from '../../lib/public-doctor';
import { loadDirectory } from '../../lib/public-doctor-server';
import { websiteJsonLd } from '../../lib/public-directory';
import { HomeLocale } from './home-locale';
import { DirectoryLoading, DirectorySection, HomeHero } from './home-view';

/**
 * Rendered per request, like the sitemap: the directory itself comes from this web
 * instance's fetch cache (five minutes by default), so the API sees about one directory
 * call per instance per cache period while it answers. A static (ISR) page would be built
 * without the API at build time and would keep a "list unavailable" page for five minutes
 * after a failure; per request, the next visit simply asks again. The hero and sign-in
 * links stream at once; the directory follows in its own Suspense boundary, waiting at
 * most three seconds for the API.
 */
export const dynamic = 'force-dynamic';

export function generateMetadata(): Metadata {
  const url = `${publicSiteUrl()}/`;
  const title = t('en', 'home.title');
  const description = t('en', 'home.description');
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: {
      type: 'website',
      url,
      title,
      description,
      siteName: t('en', 'home.brand'),
      locale: 'en_IN',
    },
  };
}

type Props = { searchParams: Promise<{ lang?: string | string[] }> };

/** The public home page (Build Plan §5.1): what the platform is, sign-in, and Find a doctor. */
export default async function HomePage({ searchParams }: Props) {
  const { lang } = await searchParams;
  const url = `${publicSiteUrl()}/`;
  return (
    <main className="min-h-dvh bg-hero px-4 py-8 sm:py-12">
      <script
        type="application/ld+json"
        data-testid="website-json-ld"
        // Escaped JSON (no `<`), as on the doctor page.
        dangerouslySetInnerHTML={{
          __html: jsonLdScript(websiteJsonLd(t('en', 'home.brand'), url)),
        }}
      />
      <HomeLocale initialLocale={lang === 'hi' ? 'hi' : 'en'}>
        <HomeHero />
        <Suspense fallback={<DirectoryLoading />}>
          <Directory />
        </Suspense>
      </HomeLocale>
    </main>
  );
}

/** The directory, fetched on the server (null when the API is busy, down or slow). */
async function Directory() {
  return <DirectorySection doctors={await loadDirectory()} />;
}
