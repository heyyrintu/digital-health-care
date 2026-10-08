import type { Metadata } from 'next';
import { publicApiBaseUrl } from '../../lib/config';
import { InviteFlow } from './invite-flow';

// The token lives in the URL fragment, so nothing about the invite reaches this server.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Set up your staff account',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

export default function InvitePage() {
  return (
    <main className="flex min-h-dvh items-start justify-center bg-hero px-4 py-10 sm:items-center sm:py-16">
      <InviteFlow apiBaseUrl={publicApiBaseUrl()} />
    </main>
  );
}
