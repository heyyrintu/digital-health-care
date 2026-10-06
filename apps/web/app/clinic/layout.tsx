import type { ReactNode } from 'react';

// Behind login and never statically rendered or cached (ADR 0002).
export const dynamic = 'force-dynamic';

export const metadata = { title: 'Clinic dashboard', robots: { index: false, follow: false } };

export default function Layout({ children }: { children: ReactNode }) {
  return children;
}
