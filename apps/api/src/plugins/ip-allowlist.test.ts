import { describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { loadConfig, platformAllowlist, proxyTrust } from '../config';
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

  it('allows nobody with an empty list, except under NODE_ENV=test', () => {
    for (const NODE_ENV of ['production', 'development', undefined]) {
      expect(platformAllowlist(loadConfig({ NODE_ENV })).allows('127.0.0.1'), NODE_ENV).toBe(false);
    }
    expect(platformAllowlist(loadConfig({ NODE_ENV: 'test' })).allows('127.0.0.1')).toBe(true);
  });

  it('allows everyone with * outside production, and refuses * in production', () => {
    const local = platformAllowlist(
      loadConfig({ NODE_ENV: 'development', PLATFORM_ALLOWED_CIDRS: '*' }),
    );
    expect(local.allows('127.0.0.1')).toBe(true);
    expect(() => loadConfig({ NODE_ENV: 'production', PLATFORM_ALLOWED_CIDRS: '*' })).toThrow(
      /not allowed in production/,
    );
  });

  it('uses the configured networks in any environment', () => {
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
  const clientIp = async (
    trustProxy: Parameters<typeof buildApp>[0]['trustProxy'],
    peer: string,
  ) => {
    const app = buildApp({ config: { LOG_LEVEL: 'silent', APP_VERSION: 'test' }, trustProxy });
    app.get('/ip', async (request) => ({ ip: request.ip }));
    // The client claims an allowed address; the load balancer appends the real one.
    const res = await app.inject({
      method: 'GET',
      url: '/ip',
      remoteAddress: peer,
      headers: { 'x-forwarded-for': '10.1.2.3, 203.0.113.9' },
    });
    await app.close();
    return (res.json() as { ip: string }).ip;
  };

  it('ignores X-Forwarded-For entries the client wrote itself', async () => {
    const ip = await clientIp({ hops: 1 }, '10.0.0.2');
    expect(ip).toBe('203.0.113.9');
    expect(
      platformAllowlist(
        loadConfig({ NODE_ENV: 'production', PLATFORM_ALLOWED_CIDRS: '10.0.0.0/8' }),
      ).allows(ip),
    ).toBe(false);
  });

  it('believes X-Forwarded-For only from peers inside TRUSTED_PROXY_CIDRS', async () => {
    const trust = proxyTrust(
      loadConfig({ NODE_ENV: 'production', TRUSTED_PROXY_CIDRS: '10.0.0.0/24' }),
    );
    expect(await clientIp(trust, '10.0.0.2')).toBe('203.0.113.9');
    // Someone reaching the API port directly: their header is ignored.
    expect(await clientIp(trust, '198.51.100.7')).toBe('198.51.100.7');
  });

  it('trusts no proxy outside production or with no hops', () => {
    expect(proxyTrust(loadConfig({ NODE_ENV: 'development' }))).toBe(false);
    expect(proxyTrust(loadConfig({ NODE_ENV: 'production', TRUST_PROXY_HOPS: '0' }))).toBe(false);
    expect(proxyTrust(loadConfig({ NODE_ENV: 'production' }))).toEqual({ hops: 1 });
    expect(() => loadConfig({ TRUSTED_PROXY_CIDRS: 'lb.internal' })).toThrow(/TRUSTED_PROXY_CIDRS/);
  });
});
