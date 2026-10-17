import { BlockList, isIPv4, isIPv6 } from 'node:net';

export interface Cidr {
  address: string;
  prefix: number;
  family: 'ipv4' | 'ipv6';
}

/**
 * Parses `203.0.113.0/24, 2001:db8::/32, 198.51.100.7` into networks; a bare address is a
 * single host. Returns null if any entry is not a valid address or prefix.
 */
export function parseCidrs(raw: string): Cidr[] | null {
  const out: Cidr[] = [];
  for (const entry of raw.split(',').map((e) => e.trim())) {
    if (!entry) continue;
    const [address = '', prefixText, extra] = entry.split('/');
    if (extra !== undefined) return null;
    const family = isIPv4(address) ? 'ipv4' : isIPv6(address) ? 'ipv6' : null;
    if (!family) return null;
    const max = family === 'ipv4' ? 32 : 128;
    const prefix = prefixText === undefined ? max : Number(prefixText);
    if (!/^\d{1,3}$/.test(prefixText ?? String(max)) || prefix < 0 || prefix > max) return null;
    out.push({ address, prefix, family });
  }
  return out;
}

/** The networks allowed to reach the platform console (PRD §3.3). */
export class IpAllowlist {
  private constructor(
    private readonly mode: 'any' | 'none' | 'list',
    private readonly list = new BlockList(),
  ) {}

  /** Everyone: development and test with no list configured. */
  static any() {
    return new IpAllowlist('any');
  }

  /** No one: production with no list configured. */
  static none() {
    return new IpAllowlist('none');
  }

  static of(cidrs: Cidr[]) {
    const list = new BlockList();
    for (const c of cidrs) list.addSubnet(c.address, c.prefix, c.family);
    return new IpAllowlist(cidrs.length ? 'list' : 'none', list);
  }

  allows(ip: string): boolean {
    if (this.mode === 'any') return true;
    if (this.mode === 'none') return false;
    // An IPv4 client on a dual-stack socket shows as ::ffff:a.b.c.d; BlockList matches
    // that against IPv4 ranges too.
    if (isIPv4(ip)) return this.list.check(ip, 'ipv4');
    if (isIPv6(ip)) return this.list.check(ip, 'ipv6');
    return false;
  }
}
