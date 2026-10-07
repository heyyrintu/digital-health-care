import type { Metadata } from 'next';
import { publicApiBaseUrl } from '../../lib/config';
import { DisplayBoardView } from './display-board';

// The screen's token lives in the URL fragment, so it never reaches this server.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Waiting room',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

/** Waiting-room screen (PRD §5.3): current and next tokens only, never patient names. */
export default function DisplayPage() {
  return <DisplayBoardView apiBaseUrl={publicApiBaseUrl()} />;
}
