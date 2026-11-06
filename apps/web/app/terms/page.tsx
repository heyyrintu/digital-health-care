import { LegalDocument } from '../legal-document';
export const metadata = { title: 'Terms of use', robots: { index: false, follow: false } };
export default function Page() {
  return <LegalDocument kind="terms" />;
}
