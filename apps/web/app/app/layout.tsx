import type { ReactNode } from 'react';
import { consentDocuments, publicApiBaseUrl } from '../../lib/config';
import { PatientSessionProvider } from './session-provider';

// Behind login and never statically rendered or cached (ADR 0002).
export const dynamic = 'force-dynamic';

// Every portal page inherits this: never indexed, never followed.
export const metadata = { title: 'Patient portal', robots: { index: false, follow: false } };

export default function Layout({ children }: { children: ReactNode }) {
  const documents = consentDocuments();
  return (
    <PatientSessionProvider
      apiBaseUrl={publicApiBaseUrl()}
      documentUrls={documents.urls}
      documentsMissing={documents.missing}
    >
      {children}
    </PatientSessionProvider>
  );
}
