import type { Metadata } from 'next';
import { publicApiBaseUrl } from '../../lib/config';
import { ReviewLandingPage } from './review-landing';
export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'Optional clinic review',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};
export default function Page() {
  return <ReviewLandingPage apiBaseUrl={publicApiBaseUrl()} />;
}
