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
    <main className="shell narrow">
      <InviteFlow apiBaseUrl={publicApiBaseUrl()} />
    </main>
  );
}
