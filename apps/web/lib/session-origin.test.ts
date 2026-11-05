import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isSameOrigin } from './session-server';

afterEach(() => vi.unstubAllEnvs());

describe('session origin behind a private standalone server', () => {
  it('accepts the configured HTTPS browser origin despite an internal request URL', () => {
    vi.stubEnv('WEB_BASE_URL', 'https://preview.example.com');
    const request = new NextRequest('http://web:3000/api/session/login', {
      headers: { origin: 'https://preview.example.com' },
    });
    expect(isSameOrigin(request)).toBe(true);
  });

  it.each([
    'https://attacker.example',
    'http://preview.example.com',
    'https://preview.example.com:8443',
  ])('rejects %s even with spoofed forwarded headers', (origin) => {
    vi.stubEnv('WEB_BASE_URL', 'https://preview.example.com');
    const request = new NextRequest('http://web:3000/api/session/login', {
      headers: { origin, host: new URL(origin).host, 'x-forwarded-host': new URL(origin).host },
    });
    expect(isSameOrigin(request)).toBe(false);
  });
});
