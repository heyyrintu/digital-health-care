import type { NextConfig } from 'next';

const securityHeaders = [
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  // Microphone is for the web scribe (Build Plan 5.1); nothing else is granted.
  { key: 'Permissions-Policy', value: 'microphone=(self), camera=(), geolocation=(), payment=()' },
];

// Clinical areas are never cached by browsers or CDNs (ADR 0002).
const noStore = [{ key: 'Cache-Control', value: 'no-store' }];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  // Workspace packages ship TypeScript source.
  transpilePackages: [
    '@dhc/api-client',
    '@dhc/contracts',
    '@dhc/domain',
    '@dhc/i18n',
    '@dhc/tokens',
  ],
  async headers() {
    return [
      { source: '/:path*', headers: securityHeaders },
      { source: '/app/:path*', headers: noStore },
      { source: '/clinic/:path*', headers: noStore },
      { source: '/platform/:path*', headers: noStore },
      { source: '/display/:path*', headers: noStore },
      { source: '/invite', headers: noStore },
    ];
  },
};

export default nextConfig;
