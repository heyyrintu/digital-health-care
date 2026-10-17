import { describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { loadConfig, platformAllowlist } from '../config';
import { IpAllowlist, parseCidrs } from './ip-allowlist';

describe('parseCidrs', () => {
  it('reads networks and single addresses', () => {
    expect(parseCidrs(' 203.0.113.0/24, 2001:db8::/32,198.51.100.7 ,')).toEqual([
      { address: '203.0.113.0', prefix: 24, family: 'ipv4' },
      { address: '2001:db8::', prefix: 32, family: 'ipv6' },
      { address: '198.51.100.7', prefix: 32, family: 'ipv4' },
    ]);
    expect(parseCidrs('')).toEqual([]);
  });

  it.each(['10.0.0.0/33', 'example.test', '10.0.0.0/8/1', '10.0.0.0/x', '::1/129'])(
    'rejects %s',
    (raw) => {
      expect(parseCidrs(raw)).toBeNull();
    },
  );
});

describe('IpAllowlist', () => {
  it('allows only addresses inside the networks, IPv4 clients on IPv6 sockets included', () => {
    const list = IpAllowlist.of(parseCidrs('10.0.0.0/8, 2001:db8::/32')!);
    expect(list.allows('10.1.2.3')).toBe(true);
    expect(list.allows('::ffff:10.1.2.3')).toBe(true);
    expect(list.allows('2001:db8::5')).toBe(true);
    expect(list.allows('11.0.0.1')).toBe(false);
    expect(list.allows('127.0.0.1')).toBe(false);
    expect(list.allows('not-an-ip')).toBe(false);
  });

  it('denies everyone in production when no list is set, and allows everyone in development', () => {
    const production = platformAllowlist(loadConfig({ NODE_ENV: 'production' }));
    expect(production.allows('127.0.0.1')).toBe(false);
    const development = platformAllowlist(loadConfig({ NODE_ENV: 'development' }));
    expect(development.allows('127.0.0.1')).toBe(true);
    const configured = platformAllowlist(
      loadConfig({ NODE_ENV: 'production', PLATFORM_ALLOWED_CIDRS: '203.0.113.0/24' }),
    );
    expect(configured.allows('203.0.113.9')).toBe(true);
    expect(configured.allows('198.51.100.1')).toBe(false);
  });

  it('refuses an invalid list at start-up', () => {
    expect(() => loadConfig({ PLATFORM_ALLOWED_CIDRS: '10.0.0.0/40' })).toThrow(
      /PLATFORM_ALLOWED_CIDRS/,
    );
  });
});

describe('client address behind the load balancer', () => {
  it('ignores X-Forwarded-For entries the client wrote itself', async () => {
    const app = buildApp({ config: { LOG_LEVEL: 'silent', APP_VERSION: 'test' }, trustProxy: 1 });
    app.get('/ip', async (request) => ({ ip: request.ip }));
    // The client claims an allowed address; the load balancer appends the real one.
    const res = await app.inject({
      method: 'GET',
      url: '/ip',
      remoteAddress: '10.0.0.2',
      headers: { 'x-forwarded-for': '10.1.2.3, 203.0.113.9' },
    });
    expect(res.json()).toEqual({ ip: '203.0.113.9' });
    expect(platformAllowlist(loadConfig({})).allows('203.0.113.9')).toBe(true);
    expect(
      platformAllowlist(
        loadConfig({ NODE_ENV: 'production', PLATFORM_ALLOWED_CIDRS: '10.0.0.0/8' }),
      ).allows(res.json().ip),
    ).toBe(false);
    await app.close();
  });

  it('trusts one proxy hop by default in production', () => {
    expect(loadConfig({}).TRUST_PROXY_HOPS).toBe(1);
  });
});
