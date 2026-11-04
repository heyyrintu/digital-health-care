import { deflateSync } from 'node:zlib';

/**
 * Tiny synthetic PDFs for the document tests (unit and integration), built here so no
 * binary test file is checked in. Each is a well-formed one-page PDF whose text says it is
 * synthetic, with a correct cross-reference: a classic table, or a cross-reference stream
 * (optionally with a PNG Up predictor, as many writers use). Images come from
 * `branding/logo-samples.ts`.
 */
export function samplePdf({
  text = 'Synthetic exercise sheet',
  extraObjects = [],
  catalogExtra = '',
  objectStream,
  xref = 'table',
  trailerExtra = '',
}: {
  text?: string;
  /** More objects, numbered from 5. */
  extraObjects?: string[];
  /** Added inside the catalog's dictionary, e.g. `/OpenAction 5 0 R`. */
  catalogExtra?: string;
  /**
   * Objects packed into a Flate-compressed object stream (`/Type /ObjStm`), with their
   * numbers; `dict` is added to its dictionary and `type` replaces `/ObjStm`.
   */
  objectStream?: { objects: [number, string][]; dict?: string; type?: string; filter?: string };
  /** A classic table, a cross-reference stream, or one with a PNG Up predictor. */
  xref?: 'table' | 'stream' | 'stream-up';
  /** Added inside the trailer's (or the cross-reference stream's) dictionary. */
  trailerExtra?: string;
} = {}): Buffer {
  const content = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const bodies = [
    `<< /Type /Catalog /Pages 2 0 R ${catalogExtra}>>`,
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    ...extraObjects,
  ];
  const parts: Buffer[] = [Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  /** Object number → offset (in the file) or [object stream, index]. */
  const where = new Map<number, number | [number, number]>();
  let length = parts[0]!.length;
  const push = (chunk: Buffer) => {
    parts.push(chunk);
    length += chunk.length;
  };
  bodies.forEach((body, i) => {
    where.set(i + 1, length);
    push(Buffer.from(`${i + 1} 0 obj\n${body}\nendobj\n`, 'latin1'));
  });
  let next = bodies.length + 1;
  if (objectStream) {
    let header = '';
    let objects = '';
    for (const [num, body] of objectStream.objects) {
      header += `${num} ${objects.length} `;
      objects += `${body}\n`;
    }
    const packed = deflateSync(Buffer.from(header + objects, 'latin1'));
    const num = next++;
    where.set(num, length);
    objectStream.objects.forEach(([member], index) => where.set(member, [num, index]));
    push(
      Buffer.concat([
        Buffer.from(
          `${num} 0 obj\n<< /Type /${objectStream.type ?? 'ObjStm'} /N ${objectStream.objects.length} /First ${header.length} /Filter ${objectStream.filter ?? '/FlateDecode'} ${objectStream.dict ?? ''} /Length ${packed.length} >>\nstream\n`,
          'latin1',
        ),
        packed,
        Buffer.from('\nendstream\nendobj\n', 'latin1'),
      ]),
    );
  }
  const xrefNum = next;
  const size = Math.max(...where.keys(), xref === 'table' ? 0 : xrefNum) + 1;
  const at = length;
  if (xref === 'table') {
    const lines = ['0000000000 65535 f '];
    for (let k = 1; k < size; k++) {
      const place = where.get(k);
      lines.push(
        typeof place === 'number'
          ? `${String(place).padStart(10, '0')} 00000 n `
          : '0000000000 00000 f ',
      );
    }
    push(
      Buffer.from(
        [
          'xref',
          `0 ${size}`,
          ...lines,
          'trailer',
          `<< /Size ${size} /Root 1 0 R ${trailerExtra}>>`,
          'startxref',
          String(at),
          '%%EOF',
          '',
        ].join('\n'),
        'latin1',
      ),
    );
    return Buffer.concat(parts);
  }
  // A cross-reference stream: rows of type (1 byte), field 2 (4 bytes), field 3 (2 bytes).
  where.set(xrefNum, at);
  const rows: number[][] = [];
  for (let k = 0; k < size; k++) {
    const place = where.get(k);
    const row = [0, 0, 0, 0, 0, 0, 0];
    if (typeof place === 'number') {
      row[0] = 1;
      row[1] = (place >>> 24) & 0xff;
      row[2] = (place >>> 16) & 0xff;
      row[3] = (place >>> 8) & 0xff;
      row[4] = place & 0xff;
    } else if (place) {
      row[0] = 2;
      row[4] = place[0];
      row[6] = place[1];
    }
    rows.push(row);
  }
  let raw: Buffer;
  let parms = '';
  if (xref === 'stream-up') {
    // PNG Up: each row is a filter byte (2) and the difference from the row above.
    raw = Buffer.from(
      rows.flatMap((row, r) => [
        2,
        ...row.map((v, x) => (v - (r > 0 ? rows[r - 1]![x]! : 0)) & 0xff),
      ]),
    );
    parms = '/DecodeParms << /Predictor 12 /Columns 7 >> ';
  } else raw = Buffer.from(rows.flat());
  const packed = deflateSync(raw);
  push(
    Buffer.concat([
      Buffer.from(
        `${xrefNum} 0 obj\n<< /Type /XRef /Size ${size} /W [1 4 2] /Root 1 0 R /Filter /FlateDecode ${parms}${trailerExtra}/Length ${packed.length} >>\nstream\n`,
        'latin1',
      ),
      packed,
      Buffer.from(`\nendstream\nendobj\nstartxref\n${at}\n%%EOF\n`, 'latin1'),
    ]),
  );
  return Buffer.concat(parts);
}
