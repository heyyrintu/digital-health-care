import type { Metadata } from 'next';
import { publicApiBaseUrl } from '../../../lib/config';
import { PaymentPage } from './payment-page';
export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'Clinic payment',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};
export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <PaymentPage token={token} apiBaseUrl={publicApiBaseUrl()} />;
}
