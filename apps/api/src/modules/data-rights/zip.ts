import { crc32 } from 'node:zlib';
/** Bounded, stored (method 0) ZIP. Internal ASCII paths only; no user filenames. */
export function makeDataZip(entries: { name: string; data: Buffer }[]): Buffer {
  if (entries.length > 300 || entries.reduce((n, e) => n + e.data.length, 0) > 50 * 1048576)
    throw new Error('EXPORT_LIMIT');
  const local: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  const names = new Set<string>();
  for (const e of entries) {
    if (!/^[a-zA-Z0-9_./-]+$/.test(e.name) || e.name.includes('..') || e.name.startsWith('/'))
      throw new Error('Unsafe archive path');
    if (names.has(e.name)) throw new Error('Duplicate archive path');
    names.add(e.name);
    const name = Buffer.from(e.name),
      crc = crc32(e.data),
      h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(33, 12);
    h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(e.data.length, 18);
    h.writeUInt32LE(e.data.length, 22);
    h.writeUInt16LE(name.length, 26);
    local.push(h, name, e.data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(33, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(e.data.length, 20);
    c.writeUInt32LE(e.data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += h.length + name.length + e.data.length;
  }
  const dir = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, dir, end]);
}
