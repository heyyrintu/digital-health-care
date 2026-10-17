import type { ReactNode } from 'react';
import { publicApiBaseUrl } from '../../lib/config';
import { PlatformSessionProvider } from './session-provider';

// Behind login and never statically rendered or cached (ADR 0002).
export const dynamic = 'force-dynamic';

// Every console page inherits this: never indexed, never followed.
export const metadata = { title: 'Platform console', robots: { index: false, follow: false } };

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <PlatformSessionProvider apiBaseUrl={publicApiBaseUrl()}>{children}</PlatformSessionProvider>
  );
}
