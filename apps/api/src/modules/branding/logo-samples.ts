import { crc32, deflateSync } from 'node:zlib';

/**
 * Tiny synthetic images for the logo tests (unit and integration): built here, byte by
 * byte, so no binary test file is checked in. The PNG is a real, decodable image; the JPEG
 * and WebP are well-formed containers (what `inspectLogo` checks), not decodable pictures.
 */

const chunk = (type: string, body: Buffer) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])));
  return Buffer.concat([head, body, crc]);
};

/** A solid-colour RGB PNG, `extra` chunks placed before the image data. */
export function samplePng({
  width = 2,
  height = 2,
  rgb = [0x1a, 0x6b, 0x5c],
  extra = [],
}: { width?: number; height?: number; rgb?: number[]; extra?: [string, Buffer][] } = {}) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array(width).fill(rgb).flat())]);
  const pixels = deflateSync(Buffer.concat(Array(height).fill(row)));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    ...extra.map(([type, body]) => chunk(type, body)),
    chunk('IDAT', pixels),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * A JPEG container: SOI, JFIF, a comment, a frame header, one scan, EOI. `layout`
 * `two_frames` adds a second frame header; `scan_first` puts the scan before the frame.
 */
export function sampleJpeg({
  width = 2,
  height = 2,
  comment = 'synthetic',
  layout = 'plain',
}: {
  width?: number;
  height?: number;
  comment?: string;
  layout?: 'plain' | 'two_frames' | 'scan_first';
} = {}) {
  const segment = (marker: number, body: Buffer) => {
    const head = Buffer.from([0xff, marker, 0, 0]);
    head.writeUInt16BE(body.length + 2, 2);
    return Buffer.concat([head, body]);
  };
  const sof = Buffer.from([8, 0, 0, 0, 0, 1, 1, 0x11, 0]);
  sof.writeUInt16BE(height, 1);
  sof.writeUInt16BE(width, 3);
  const scan = Buffer.concat([
    segment(0xda, Buffer.from([1, 1, 0, 0, 63, 0])),
    // Scan data with a stuffed 0xFF00 and a restart marker inside.
    Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78]),
  ]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    segment(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1')),
    segment(0xfe, Buffer.from(comment, 'latin1')),
    ...(layout === 'scan_first'
      ? [scan, segment(0xc0, sof)]
      : layout === 'two_frames'
        ? [segment(0xc0, sof), segment(0xc2, sof), scan]
        : [segment(0xc0, sof), scan]),
    Buffer.from([0xff, 0xd9]),
  ]);
}

/**
 * A lossless WebP container (`VP8L`), with optional chunks after it; `extended` puts a
 * `VP8X` header first, with `flags` (0x02: animation).
 */
export function sampleWebp({
  width = 2,
  height = 2,
  extra = [],
  extended,
}: {
  width?: number;
  height?: number;
  extra?: [string, Buffer][];
  extended?: { flags: number };
} = {}) {
  const riffChunk = (type: string, body: Buffer) => {
    const head = Buffer.alloc(8);
    head.write(type, 0, 'latin1');
    head.writeUInt32LE(body.length, 4);
    return Buffer.concat([head, body, body.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
  };
  const vp8l = Buffer.alloc(6);
  vp8l[0] = 0x2f;
  vp8l.writeUInt32LE(((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14), 1);
  const vp8x = Buffer.alloc(10);
  if (extended) {
    vp8x[0] = extended.flags;
    vp8x.writeUIntLE(width - 1, 4, 3);
    vp8x.writeUIntLE(height - 1, 7, 3);
  }
  const body = Buffer.concat([
    Buffer.from('WEBP', 'latin1'),
    ...(extended ? [riffChunk('VP8X', vp8x)] : []),
    riffChunk('VP8L', vp8l),
    ...extra.map(([type, data]) => riffChunk(type, data)),
  ]);
  const head = Buffer.alloc(8);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

export const SAMPLE_SVG = Buffer.from(
  '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
);
