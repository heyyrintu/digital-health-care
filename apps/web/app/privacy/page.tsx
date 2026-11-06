import { LegalDocument } from '../legal-document';
export const metadata = { title: 'Privacy Notice', robots: { index: false, follow: false } };
export default function Page() {
  return <LegalDocument kind="privacy_notice" />;
}
