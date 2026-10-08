import '@fontsource-variable/figtree';
import '@fontsource-variable/manrope';
import '@fontsource-variable/noto-sans-devanagari';
import { themeStylesheet, toCssVariables } from '@dhc/tokens';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './styles.css';

export const metadata: Metadata = {
  title: { default: 'Digital Healthcare Platform', template: '%s · Digital Healthcare Platform' },
  description: 'Book appointments, consult your doctor and keep your health records in one place.',
};

// Theme values (light on :root, dark on .dark) plus the earlier token scales, which stay
// until the mobile app moves to the theme.
const rootCss = themeStylesheet(toCssVariables());

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
