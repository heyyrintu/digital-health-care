import type { Metadata } from 'next';
import { publicApiBaseUrl } from '../../../lib/config';
import { VerifyResult } from './verify-result';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Prescription check',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

/** The page a prescription's QR opens (PRD §9.4): Genuine, Superseded or Void. Public. */
export default async function VerifyPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  return (
    <main className="flex min-h-dvh items-start justify-center bg-hero px-4 py-10 sm:py-16">
      <VerifyResult apiBaseUrl={publicApiBaseUrl()} code={code} />
    </main>
  );
}
