import type { ReactNode } from 'react';
import { SessionProvider } from './session-provider';

// Behind login and never statically rendered or cached (ADR 0002).
export const dynamic = 'force-dynamic';

export const metadata = { title: 'Clinic dashboard', robots: { index: false, follow: false } };

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <SessionProvider
      apiBaseUrl={process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000/v1'}
    >
      {children}
    </SessionProvider>
  );
}
