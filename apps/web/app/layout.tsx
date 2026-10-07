import { toCssVariables } from '@dhc/tokens';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Digital Healthcare Platform', template: '%s · Digital Healthcare Platform' },
  description: 'Book appointments, consult your doctor and keep your health records in one place.',
};

const rootCss = `:root{${Object.entries(toCssVariables())
  .map(([name, value]) => `${name}:${value}`)
  .join(';')}}`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <style>{rootCss}</style>
      </head>
      <body>{children}</body>
    </html>
  );
}
