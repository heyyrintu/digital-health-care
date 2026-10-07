import { t } from '@dhc/i18n';
import Link from 'next/link';

export default function HomePage() {
  return (
    <main className="shell">
      <p className="eyebrow">Digital Healthcare Platform</p>
      <h1>{t('en', 'booking.book')}</h1>
      <p>Public website placeholder. Doctor pages, booking and verification arrive in Phase 1.</p>
      <nav>
        <ul>
          <li>
            <Link href="/app">Patient portal</Link>
          </li>
          <li>
            <Link href="/clinic">Clinic dashboard</Link>
          </li>
        </ul>
      </nav>
    </main>
  );
}
