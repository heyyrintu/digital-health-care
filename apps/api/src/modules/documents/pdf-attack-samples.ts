import { deflateSync } from 'node:zlib';
import { samplePdf } from './document-samples';

/**
 * Hostile PDFs for the rebuild's tests (threat model T27), built here so no binary test file
 * is checked in. Each recreates a shape that hid a live script from the earlier scanner, or
 * that made a parser spend unbounded time or memory. All are synthetic: the "script" is
 * `app.alert(1)`.
 */

export const SCRIPT = '<< /Type /Action /S /JavaScript /JS (app.alert\\(1\\)) >>';

const PAGES =
  '\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n' +
  '\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>\nendobj\n';
const catalog = (extra = '/OpenAction 5 0 R ') =>
  `\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R ${extra}>>\nendobj\n`;

/**
 * A PDF from raw chunks, with a classic cross-reference listing, for each number below
 * `size`, the first `\nn 0 obj` (or `n 0obj`) found anywhere, stream data included.
 */
export function rawPdf(chunks: string[], size: number, trailerExtra = ''): Buffer {
  let body = `%PDF-1.7\n%\xe2\xe3\xcf\xd3\n${chunks.join('')}`;
  const lines = ['0000000000 65535 f '];
  for (let k = 1; k < size; k++) {
    let at = body.indexOf(`\n${k} 0 obj`) + 1;
    if (at === 0) at = body.indexOf(`${k} 0obj`);
    lines.push(at > 0 ? `${String(at).padStart(10, '0')} 00000 n ` : '0000000000 00000 f ');
  }
  const xref = body.length;
  body += `xref\n0 ${size}\n${lines.join('\n')}\ntrailer\n<< /Size ${size} /Root 1 0 R ${trailerExtra}>>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

/** A PDF of numbered objects (`[number, body]`, bodies as latin1 or bytes) and a classic table. */
function objectsPdf(objects: [number, string | Buffer][], trailer: string): Buffer {
  const parts: Buffer[] = [Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let length = parts[0]!.length;
  const offsets = new Map<number, number>();
  for (const [num, body] of objects) {
    offsets.set(num, length);
    const chunk = Buffer.concat([
      Buffer.from(`${num} 0 obj\n`),
      typeof body === 'string' ? Buffer.from(body, 'latin1') : body,
      Buffer.from('\nendobj\n'),
    ]);
    parts.push(chunk);
    length += chunk.length;
  }
  const size = Math.max(...offsets.keys()) + 1;
  const lines = ['0000000000 65535 f '];
  for (let k = 1; k < size; k++) {
    const at = offsets.get(k);
    lines.push(at ? `${String(at).padStart(10, '0')} 00000 n ` : '0000000000 00000 f ');
  }
  parts.push(
    Buffer.from(
      `xref\n0 ${size}\n${lines.join('\n')}\ntrailer\n<< /Size ${size} /Root 1 0 R ${trailer}>>\nstartxref\n${length}\n%%EOF\n`,
      'latin1',
    ),
  );
  return Buffer.concat(parts);
}

const stream = (dict: string, data: Buffer) =>
  Buffer.concat([
    Buffer.from(`<< ${dict} /Length ${data.length} >>\nstream\n`, 'latin1'),
    data,
    Buffer.from('\nendstream', 'latin1'),
  ]);

/** Every way the catalog, a page and its annotations can carry active content, at once. */
export function everyActiveContent(): Buffer {
  const content = 'BT /F1 12 Tf 72 720 Td (Synthetic exercise sheet) Tj ET';
  return objectsPdf(
    [
      [
        1,
        '<< /Type /Catalog /Pages 2 0 R /OpenAction 5 0 R /AA << /WC 5 0 R >> ' +
          '/Names << /JavaScript << /Names [(x) 5 0 R] >> /EmbeddedFiles << /Names [(a.exe) 6 0 R] >> >> ' +
          '/AcroForm << /Fields [7 0 R] /XFA 8 0 R >> /Outlines 9 0 R /OCProperties << /OCGs [] >> ' +
          '/StructTreeRoot << /Type /StructTreeRoot >> /URI << /Base (https://example.invalid/) >> >>',
      ],
      [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
      [
        3,
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R ' +
          '/Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> ' +
          '/AA << /O 5 0 R >> /Annots [7 0 R 10 0 R 11 0 R] >>',
      ],
      [4, stream('', Buffer.from(content, 'latin1'))],
      [5, SCRIPT],
      [6, '<< /Type /Filespec /F (a.exe) /EF << /F 12 0 R >> >>'],
      [
        7,
        '<< /Type /Annot /Subtype /Widget /FT /Tx /T (name) /Rect [0 0 10 10] /P 3 0 R /AA << /K 5 0 R >> /A << /S /SubmitForm /F (https://example.invalid/) >> >>',
      ],
      [8, stream('', Buffer.from('<xdp:xdp/>', 'latin1'))],
      [9, '<< /Type /Outlines /First 13 0 R /Last 13 0 R /Count 1 >>'],
      [10, '<< /Type /Annot /Subtype /Link /Rect [0 0 10 10] /A << /S /Launch /F (calc.exe) >> >>'],
      [
        11,
        '<< /Type /Annot /Subtype /Link /Rect [0 0 10 10] /A << /S /GoToR /F (other.pdf) /D [0 /Fit] >> >>',
      ],
      [12, stream('/Type /EmbeddedFile', Buffer.from('MZ synthetic', 'latin1'))],
      [13, '<< /Title (Open) /Parent 9 0 R /A 5 0 R >>'],
    ],
    '/Info << /Title (Synthetic) /Author (app.alert) >> ',
  );
}

/** The catalog opens a script packed in a compressed object stream. */
export const scriptInObjectStream = (xref: 'table' | 'stream' = 'stream') =>
  samplePdf({ catalogExtra: '/OpenAction 5 0 R ', objectStream: { objects: [[5, SCRIPT]] }, xref });

/**
 * Objects hidden in stream data: (a) object 5 inside a stream's data, the cross-reference
 * pointing at it; (b) behind a bare `stream` keyword between objects; (c) inside the page's
 * own content stream, so the stream is copied.
 */
export function scriptsInStreamData(): Buffer[] {
  const inner = `\n5 0 obj\n${SCRIPT}\nendobj\n`;
  const page =
    '\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R >>\nendobj\n';
  return [
    rawPdf(
      [
        catalog(),
        PAGES,
        `\n4 0 obj\n<< /Length ${inner.length} >>\nstream\n${inner}\nendstream\nendobj\n`,
      ],
      6,
    ),
    rawPdf([catalog(), PAGES, `\nstream\n5 0 obj\n${SCRIPT}\nendobj\nendstream\n`], 6),
    rawPdf(
      [
        catalog(),
        '\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
        page,
        `\n4 0 obj\n<< /Length ${inner.length} >>\nstream\n${inner}\nendstream\nendobj\n`,
      ],
      6,
    ),
  ];
}

/** Object stream 4 twice: a decoy, then one typed `/ObjStm` by reference holding the script. */
export function duplicateObjectStream(): Buffer {
  const parts: Buffer[] = [Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let length = parts[0]!.length;
  const offsets: number[] = [];
  const push = (chunk: Buffer) => {
    parts.push(chunk);
    length += chunk.length;
  };
  const object = (num: number, body: string) => {
    offsets[num] = length;
    push(Buffer.from(`${num} 0 obj\n${body}\nendobj\n`, 'latin1'));
  };
  object(1, '<< /Type /Catalog /Pages 2 0 R /OpenAction 7 0 R >>');
  object(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  object(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>');
  const header = '6 0 7 5 ';
  const decoy = deflateSync(Buffer.from(`${header}null null`));
  push(
    Buffer.concat([
      Buffer.from(
        `4 0 obj\n<< /Type /ObjStm /N 2 /First ${header.length} /Filter /FlateDecode /Length ${decoy.length} >>\nstream\n`,
      ),
      decoy,
      Buffer.from('\nendstream\nendobj\n'),
    ]),
  );
  const hidden = `${header}null ${SCRIPT}`;
  offsets[4] = length;
  push(
    Buffer.from(
      `4 0 obj\n<< /Type 9 0 R /N 2 /First ${header.length} /Length ${hidden.length} >>\nstream\n${hidden}\nendstream\nendobj\n`,
      'latin1',
    ),
  );
  object(9, '/ObjStm');
  offsets[5] = length;
  const row = (t: number, a: number, b: number) =>
    Buffer.from([
      t,
      (a >>> 24) & 255,
      (a >>> 16) & 255,
      (a >>> 8) & 255,
      a & 255,
      (b >> 8) & 255,
      b & 255,
    ]);
  const rows = deflateSync(
    Buffer.concat([
      row(0, 0, 65535),
      ...[1, 2, 3, 4, 5].map((n) => row(1, offsets[n]!, 0)),
      row(2, 4, 0),
      row(2, 4, 1),
      row(0, 0, 0),
      row(1, offsets[9]!, 0),
    ]),
  );
  push(
    Buffer.concat([
      Buffer.from(
        `5 0 obj\n<< /Type /XRef /Size 10 /W [1 4 2] /Root 1 0 R /Filter /FlateDecode /Length ${rows.length} >>\nstream\n`,
      ),
      rows,
      Buffer.from(`\nendstream\nendobj\nstartxref\n${offsets[5]}\n%%EOF\n`),
    ]),
  );
  return Buffer.concat(parts);
}

/** Scripts the pages reach through their resources (copied, so they must be neutered). */
export function scriptsInResources(): Buffer {
  return objectsPdf(
    [
      [1, '<< /Type /Catalog /Pages 2 0 R /OpenAction 5 0 R >>'],
      [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
      [
        3,
        // The resources point back at the catalog, at a script and at an escaped one.
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Properties << /P1 1 0 R /P2 5 0 R /P3 6 0 R >> /XObject << /X1 7 0 R >> >> >>',
      ],
      [5, SCRIPT],
      [6, '<< /S /J#61vaScript /J#53 (app.alert\\(1\\)) /Next [/Launch /GoToE] >>'],
      [
        7,
        stream(
          '/Type /XObject /Subtype /Form /BBox [0 0 10 10] /AA << /O 5 0 R >> /Resources << /XObject << /Bad 5 0 R >> >>',
          Buffer.from('0 0 m 10 10 l S', 'latin1'),
        ),
      ],
    ],
    '',
  );
}

/** A cross-reference stream whose /Size claims two billion entries. */
export function hugeXrefSize(): Buffer {
  const base = samplePdf({ xref: 'stream' }).toString('latin1');
  return Buffer.from(
    base.replace(/\/Type \/XRef \/Size \d+/, '/Type /XRef /Size 2000000000'),
    'latin1',
  );
}

/** A classic cross-reference subsection claiming two billion entries. */
export function hugeXrefTable(): Buffer {
  const base = samplePdf().toString('latin1');
  return Buffer.from(base.replace(/xref\n0 (\d+)\n/, 'xref\n0 2000000000\n'), 'latin1');
}

/** An object stream whose header claims 100 million objects at huge offsets. */
export function objectStreamHeaderBomb(): Buffer {
  const header = Buffer.from('1 1 '.repeat(8 * 1024 * 1024 - 16));
  const packed = deflateSync(header, { level: 9 });
  return objectsPdf(
    [
      [1, '<< /Type /Catalog /Pages 2 0 R >>'],
      [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
      [3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>'],
      [
        4,
        stream(`/Type /ObjStm /N 100000000 /First ${header.length} /Filter /FlateDecode`, packed),
      ],
    ],
    '',
  );
}

/** An object stream that inflates to `mb` megabytes (a few hundred kilobytes on disk). */
export function objectStreamZipBomb(mb: number): Buffer {
  const data = Buffer.alloc(mb * 1024 * 1024, 0x20);
  data.write('5 0 ');
  const packed = deflateSync(data, { level: 9 });
  return objectsPdf(
    [
      [1, '<< /Type /Catalog /Pages 2 0 R >>'],
      [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
      [3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>'],
      [4, stream('/Type /ObjStm /N 1 /First 4 /Filter /FlateDecode', packed)],
    ],
    '',
  );
}

/** Arrays nested `depth` deep in the page's resources. */
export const deepNesting = (depth: number) =>
  objectsPdf(
    [
      [1, '<< /Type /Catalog /Pages 2 0 R >>'],
      [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
      [
        3,
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Properties << /Deep ${'['.repeat(depth)}${']'.repeat(depth)} >> >> >>`,
      ],
    ],
    '',
  );

/** A name of `length` characters (escaped, so four bytes each) in the page's resources. */
export const longName = (length: number) =>
  objectsPdf(
    [
      [1, `<< /Type /Catalog /Pages 2 0 R /${'A#41'.repeat(length)} 1 >>`],
      [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
      [
        3,
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Properties << /${'A#41'.repeat(length)} 1 >> >> >>`,
      ],
    ],
    '',
  );

/** A page tree whose /Count claims a billion pages, and one whose node is its own kid. */
export const lyingPageCount = () =>
  rawPdf([catalog(''), PAGES.replace('/Count 1', '/Count 1000000000')], 4);
export const cyclicPageTree = () =>
  rawPdf([catalog(''), '\n2 0 obj\n<< /Type /Pages /Kids [2 0 R] /Count 1 >>\nendobj\n'], 3);

/** An encrypted file (the trailer names an encryption dictionary). */
export const encryptedPdf = () =>
  objectsPdf(
    [
      [1, '<< /Type /Catalog /Pages 2 0 R >>'],
      [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
      [3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>'],
      [4, '<< /Filter /Standard /V 2 /R 3 /Length 128 /O <00> /U <00> /P -4 >>'],
    ],
    '/Encrypt 4 0 R ',
  );

/**
 * The page tree packed in an object stream followed by `mb` megabytes of padding, compressed
 * through `filters` Flate stages. Its pages can be read only by inflating the whole stream,
 * so the rebuild's decoding budget and filter-chain cap decide whether the file comes out.
 */
export function pagesInObjectStream(mb: number, filters = 1): Buffer {
  const pages = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>';
  const page = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>';
  const header = `2 0 3 ${pages.length + 1} `;
  let data: Buffer = Buffer.alloc(
    header.length + pages.length + page.length + 2 + mb * 1024 * 1024,
    0x20,
  );
  data.write(`${header}${pages} ${page}`, 'latin1');
  for (let i = 0; i < filters; i++) data = deflateSync(data, { level: 9 });
  const chain = filters === 1 ? '/FlateDecode' : `[${' /FlateDecode'.repeat(filters)} ]`;
  return objectsPdf(
    [
      [1, '<< /Type /Catalog /Pages 2 0 R >>'],
      [4, stream(`/Type /ObjStm /N 2 /First ${header.length} /Filter ${chain}`, data)],
    ],
    '',
  );
}

/** A page with `resources` and a plain content stream (`contentDict` added to its dictionary). */
const pageWith = (resources: string, extra: string[] = [], contentDict = '') =>
  objectsPdf(
    [
      [1, '<< /Type /Catalog /Pages 2 0 R >>'],
      [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
      [
        3,
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources ${resources} /Contents 4 0 R >>`,
      ],
      [4, stream(contentDict, Buffer.from('BT /F1 12 Tf 10 10 Td (hi) Tj ET', 'latin1'))],
      ...extra.map((body, i): [number, string] => [5 + i, body]),
    ],
    '',
  );

/** A launch action whose `/S` is a name given by reference (`/S 6 0 R`, `6 0 obj /Launch`). */
export const indirectBlockedName = () =>
  pageWith('<< /Properties << /P 5 0 R >> >>', [
    '<< /Type /Action /S 6 0 R /F (calc.exe) >>',
    '/Launch',
  ]);

/** References to other files and sites: an external image, a reference XObject, a URI action. */
export const externalReferences = () =>
  pageWith(
    '<< /XObject << /Im1 5 0 R /Fm1 6 0 R >> /Properties << /U << /S /URI /URI (https://example.invalid/beacon) >> >> >>',
    [
      '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /BitsPerComponent 8 /ColorSpace /DeviceGray /F << /FS /URL /F (https://example.invalid/beacon) >> /FFilter /DCTDecode /FDecodeParms << >> /Metadata 7 0 R /Length 1 >>\nstream\n\x00\nendstream',
      '<< /Type /XObject /Subtype /Form /BBox [0 0 1 1] /Ref << /F << /FS /URL /F (https://example.invalid/x.pdf) >> /Page 0 >> /Length 0 >>\nstream\n\nendstream',
      '<< /Type /Metadata /Subtype /XML /Length 9 >>\nstream\n<x:xmp/>\n\nendstream',
    ],
  );

/** A page whose content stream claims a filter that is not one: `[]`, `null` or a number. */
export const fakeFilter = (filter: '[]' | 'null' | '7') =>
  pageWith('<< >>', [], `/Filter ${filter}`);
