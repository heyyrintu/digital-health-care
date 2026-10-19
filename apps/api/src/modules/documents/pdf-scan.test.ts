import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { checkOwnPdf, MAX_DEPTH } from './pdf-scan';

/** A small file in the shape the rebuild writes: pdf-lib, object streams off. */
async function own(extra?: (doc: PDFDocument) => void): Promise<string> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.setProducer('Digital Healthcare');
  doc.addPage().drawText('Synthetic sheet (with a /JS name in a string)', {
    font: await doc.embedFont(StandardFonts.Helvetica),
  });
  extra?.(doc);
  return Buffer.from(await doc.save({ useObjectStreams: false })).toString('latin1');
}
const check = (text: string) => checkOwnPdf(Buffer.from(text, 'latin1'));

/** Replaces an object's dictionary opening, keeping every offset (same length). */
const sameLength = (text: string, from: string, to: string) => {
  expect(to.length).toBe(from.length);
  expect(text).toContain(from);
  return text.replace(from, to);
};

describe('checkOwnPdf', () => {
  it('passes what the rebuild writes, names in strings and stream data included', async () => {
    expect(check(await own())).toBeNull();
    // Nesting up to the limit.
    const nested = await own((doc) =>
      doc.catalog.set(
        PDFName.of('Deep'),
        doc.context.obj(JSON.parse('['.repeat(MAX_DEPTH - 1) + ']'.repeat(MAX_DEPTH - 1)) as never),
      ),
    );
    expect(check(nested)).toBeNull();
  });

  it('fails on a blocked name anywhere outside stream data, escaped too', async () => {
    const text = await own();
    for (const name of ['/JS', '/AA', '/J#53', '/XFA', '/RichMedia']) {
      const out = text.replace('/Type /Catalog', `/Type /Catalog ${name} 1`);
      // The table is now off by the inserted length; the name is found first.
      expect(check(out), name).toMatch(/blocked name/);
    }
    expect(check(text.replace('/Type /Catalog', '/Type /ObjStm'))).toMatch(/blocked name \/ObjStm/);
    for (const name of ['/URI', '/URL', '/Metadata']) {
      expect(check(text.replace('/Type /Catalog', `/Type /Catalog /X ${name}`)), name).toMatch(
        /blocked name/,
      );
    }
  });

  it('fails on object and cross-reference streams (pdf-lib with object streams on)', async () => {
    const doc = await PDFDocument.create();
    doc.addPage();
    const packed = Buffer.from(await doc.save({ useObjectStreams: true })).toString('latin1');
    expect(check(packed)).not.toBeNull();
  });

  it('fails on a cross-reference that does not match the objects', async () => {
    const text = await own();
    const at = text.lastIndexOf('startxref\n') + 10;
    const xref = Number(/startxref\n(\d+)/.exec(text)![1]);
    for (const [name, broken] of [
      ['startxref', text.slice(0, at) + String(xref + 1) + text.slice(at + String(xref).length)],
      [
        'offset',
        text.replace(
          /\n(\d{10}) 00000 n /,
          (_, o: string) => `\n${String(Number(o) + 1).padStart(10, '0')} 00000 n `,
        ),
      ],
      ['appended', `${text}<html></html>`],
      ['encrypt', sameLength(text, '/Root', '/Encr')],
      ['header', text.replace('%PDF-1.7', '%PDF-9.7')],
    ] as const) {
      expect(check(broken), name).not.toBeNull();
    }
  });

  it('fails on comments, unknown keywords and nesting past the limit inside objects', async () => {
    const text = await own();
    expect(check(sameLength(text, '/Type /Catalog', '%Type /Catalog'))).not.toBeNull();
    expect(check(sameLength(text, '/Type /Catalog', '/Type {Catalog'))).not.toBeNull();
    const deep = await own((doc) =>
      doc.catalog.set(
        PDFName.of('Deep'),
        doc.context.obj(JSON.parse('['.repeat(MAX_DEPTH + 1) + ']'.repeat(MAX_DEPTH + 1)) as never),
      ),
    );
    expect(check(deep)).toMatch(/nested too deep/);
  });

  it('fails on a stream pointing at another file', async () => {
    for (const key of ['F', 'FFilter', 'FDecodeParms', 'Ref']) {
      const out = await own((doc) => {
        const stream = doc.context.stream('q Q', { [key]: 1 });
        doc.catalog.set(PDFName.of('X'), doc.context.register(stream));
      });
      expect(check(out), key).toMatch(new RegExp(`has /${key}`));
    }
  });

  it('fails on an object header in stream data, in linear time', async () => {
    const hidden = await own((doc) => {
      const stream = doc.context.stream('q 9 0 obj << >> endobj Q');
      doc.catalog.set(PDFName.of('X'), doc.context.register(stream));
    });
    expect(check(hidden)).toMatch(/object header in stream/);
    // 8 MB of digits and spaces with `obj` nowhere: still quick.
    const digits = await own((doc) => {
      const stream = doc.context.stream('1 '.repeat(4 * 1024 * 1024));
      doc.catalog.set(PDFName.of('X'), doc.context.register(stream));
    });
    const started = performance.now();
    expect(check(digits)).toBeNull();
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
