import { inflateSync } from 'node:zlib';

/**
 * The text of a PDF the API rendered (pdfkit), for checking what a prescription prints.
 * pdfkit writes each embedded font's glyphs as hex strings and a ToUnicode map per font;
 * this decodes the `TJ`/`Tj` strings of every page with those maps. Enough for our own
 * PDFs, not a general PDF reader. Text runs come back joined with spaces, in drawing order.
 */
export function pdfText(pdf: Buffer): string {
  const source = pdf.toString('latin1');
  const objects = new Map<string, string>();
  for (const m of source.matchAll(/(\d+) 0 obj\s*([\s\S]*?)endobj/g)) objects.set(m[1]!, m[2]!);

  const streamOf = (body: string): string => {
    const start = body.indexOf('stream');
    if (start < 0) return '';
    const from = start + (body[start + 6] === '\r' ? 8 : 7);
    const raw = Buffer.from(body.slice(from, body.lastIndexOf('endstream')), 'latin1');
    return /\/FlateDecode/.test(body)
      ? inflateSync(raw).toString('latin1')
      : raw.toString('latin1');
  };

  // Each font's ToUnicode map: glyph code → text.
  const maps = new Map<string, Map<number, string>>();
  const unicode = (hex: string) =>
    String.fromCodePoint(...(hex.match(/.{4}/g) ?? []).map((h) => parseInt(h, 16)));
  for (const [id, body] of objects) {
    const ref = /\/ToUnicode (\d+) 0 R/.exec(body);
    if (!ref) continue;
    const cmap = streamOf(objects.get(ref[1]!) ?? '');
    const map = new Map<number, string>();
    for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
      for (const r of block[1]!.matchAll(
        /<([0-9a-f]+)>\s*<([0-9a-f]+)>\s*(\[[^\]]*\]|<[0-9a-f]+>)/gi,
      )) {
        const lo = parseInt(r[1]!, 16);
        const hi = parseInt(r[2]!, 16);
        const targets = r[3]!.startsWith('[')
          ? [...r[3]!.matchAll(/<([0-9a-f]+)>/gi)].map((t) => t[1]!)
          : null;
        for (let code = lo; code <= hi; code++) {
          if (targets) map.set(code, unicode(targets[code - lo] ?? ''));
          else {
            const base = r[3]!.slice(1, -1);
            map.set(code, String.fromCodePoint(parseInt(base, 16) + code - lo));
          }
        }
      }
    }
    for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
      for (const c of block[1]!.matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]+)>/gi)) {
        map.set(parseInt(c[1]!, 16), unicode(c[2]!));
      }
    }
    maps.set(id, map);
  }

  // Page resources name fonts (/F1 12 0 R); content streams select them with `/F1 9 Tf`.
  const fontRefs = new Map<string, string>();
  for (const body of objects.values()) {
    const fonts = /\/Font\s*<<([^>]*)>>/.exec(body);
    if (!fonts) continue;
    for (const f of fonts[1]!.matchAll(/\/(\w+) (\d+) 0 R/g)) fontRefs.set(f[1]!, f[2]!);
  }
  const runs: string[] = [];
  for (const body of objects.values()) {
    if (!/\/Length/.test(body) || /\/Subtype|\/Type \/XObject|\/ToUnicode/.test(body)) continue;
    const content = streamOf(body);
    if (!/\bTJ\b|\bTj\b/.test(content)) continue;
    let map: Map<number, string> | undefined;
    for (const op of content.matchAll(
      /\/(\w+) [\d.]+ Tf|\[((?:<[0-9a-f]*>|[^\]])*)\] TJ|<([0-9a-f]*)> Tj/gi,
    )) {
      if (op[1]) {
        map = maps.get(fontRefs.get(op[1]) ?? '');
        continue;
      }
      const hexes = op[2] ? [...op[2].matchAll(/<([0-9a-f]*)>/gi)].map((h) => h[1]!) : [op[3]!];
      const text = hexes
        .map((hex) =>
          (hex.match(/.{4}/g) ?? []).map((code) => map?.get(parseInt(code, 16)) ?? '').join(''),
        )
        .join('');
      if (text) runs.push(text);
    }
  }
  return runs.join(' ').replace(/\s+/g, ' ');
}
