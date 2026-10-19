import type { Metadata } from 'next';
import { publicApiBaseUrl } from '../../../../lib/config';
import { VerifyResult } from '../../[code]/verify-result';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Referral letter check',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

/**
 * The page a referral letter's QR opens (PRD §7.2): the same check as for prescriptions,
 * with the letter's own lookup. Public.
 */
export default async function VerifyLetterPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  return (
    <main className="flex min-h-dvh items-start justify-center bg-hero px-4 py-10 sm:py-16">
      <VerifyResult apiBaseUrl={publicApiBaseUrl()} code={code} document="referral-letter" />
    </main>
  );
}
