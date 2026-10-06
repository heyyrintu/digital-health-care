import type { ReactNode } from 'react';
import { publicApiBaseUrl } from '../../lib/config';
import { SessionProvider } from './session-provider';

// Behind login and never statically rendered or cached (ADR 0002).
export const dynamic = 'force-dynamic';

export const metadata = { title: 'Clinic dashboard', robots: { index: false, follow: false } };

export default function Layout({ children }: { children: ReactNode }) {
  return <SessionProvider apiBaseUrl={publicApiBaseUrl()}>{children}</SessionProvider>;
}
