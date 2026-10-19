import { PDFDocument, StandardFonts } from 'pdf-lib';
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { AppError } from '../../errors';
import { SAMPLE_SVG, sampleJpeg, samplePng, sampleWebp } from '../branding/logo-samples';
import { acceptDocument, inspectDocument, inspectPdf } from './content';
import { renderReferralLetterPdf } from '../referrals/letter-pdf';
import { samplePdf } from './document-samples';

const clinic = { maxUploadMb: 1, uploadTypes: ['pdf' as const, 'jpeg' as const, 'png' as const] };

const reason = (mediaType: string, data: Buffer, settings = clinic) => {
  try {
    return acceptDocument(settings, { mediaType, data });
  } catch (e) {
    if (e instanceof AppError) return e.fields?.file;
    throw e;
  }
};

/** A PDF from raw chunks, with a classic cross-reference listing `n 0 obj` wherever found. */
function rawPdf(chunks: string[], size: number, trailerExtra = ''): Buffer {
  let body = `%PDF-1.7\n%\xe2\xe3\xcf\xd3\n${chunks.join('')}`;
  const lines = ['0000000000 65535 f '];
  for (let k = 1; k < size; k++) {
    const at = body.indexOf(`\n${k} 0 obj`) + 1;
    lines.push(at > 0 ? `${String(at).padStart(10, '0')} 00000 n ` : '0000000000 00000 f ');
  }
  const xref = body.length;
  body += `xref\n0 ${size}\n${lines.join('\n')}\ntrailer\n<< /Size ${size} /Root 1 0 R ${trailerExtra}>>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}
const pages =
  '\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n' +
  '\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>\nendobj\n';
const catalog = (extra = '/OpenAction 5 0 R ') =>
  `\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R ${extra}>>\nendobj\n`;
const js = '<< /Type /Action /S /JavaScript /JS (app.alert\\(1\\)) >>';
const uri = '<< /S /URI /URI (https://example.invalid/opened) >>';

/** Runs `check` and returns how long it took and how much the heap grew, roughly. */
function measured<T>(check: () => T) {
  const heap = process.memoryUsage().heapUsed;
  const started = performance.now();
  const result = check();
  return {
    result,
    ms: performance.now() - started,
    mb: (process.memoryUsage().heapUsed - heap) / 1024 / 1024,
  };
}

describe('inspectPdf', () => {
  it('accepts a plain PDF, also with whitespace after the end marker', () => {
    expect(inspectPdf(samplePdf())).toBe('ok');
    expect(inspectPdf(Buffer.concat([samplePdf(), Buffer.from('\r\n\n')]))).toBe('ok');
    // An action that only opens the first page is fine.
    expect(inspectPdf(samplePdf({ catalogExtra: '/OpenAction [3 0 R /Fit] ' }))).toBe('ok');
  });

  it('refuses a header that is not at the start, and markup in the head', () => {
    expect(inspectPdf(Buffer.concat([Buffer.from('<html>'), samplePdf()]))).toBe('type_mismatch');
    expect(inspectPdf(Buffer.from('GIF89a'))).toBe('type_mismatch');
    const withHtml = Buffer.from(
      samplePdf().toString('latin1').replace('%PDF-1.7\n', '%PDF-1.7\n%<html><script>x</script>\n'),
      'latin1',
    );
    expect(inspectPdf(withHtml)).toBe('not_a_document');
  });

  it('refuses anything appended after the end marker (a polyglot) and a missing marker', () => {
    expect(inspectPdf(Buffer.concat([samplePdf(), Buffer.from('PK\x03\x04synthetic zip')]))).toBe(
      'not_a_document',
    );
    expect(inspectPdf(Buffer.concat([samplePdf(), Buffer.from('<html></html>')]))).toBe(
      'not_a_document',
    );
    expect(inspectPdf(Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n'))).toBe('not_a_document');
  });

  it('refuses scripts, launch actions, attachments and XFA, escaped names too', () => {
    for (const pdf of [
      samplePdf({ catalogExtra: '/OpenAction 5 0 R ', extraObjects: [js] }),
      samplePdf({ extraObjects: ['<< /S /Launch /F (calc.exe) >>'] }),
      samplePdf({ extraObjects: ['<< /Type /EmbeddedFile /Length 0 >>'] }),
      samplePdf({ catalogExtra: '/AcroForm << /XFA 5 0 R >> ' }),
      samplePdf({ extraObjects: ['<< /S /J#61vaScript /J#53 (x) >>'] }),
    ]) {
      expect(inspectPdf(pdf)).toBe('active_content');
    }
  });

  it('looks inside compressed object streams', () => {
    expect(
      inspectPdf(samplePdf({ objectStream: { objects: [[20, '<< /Producer (synthetic) >>']] } })),
    ).toBe('ok');
    expect(inspectPdf(samplePdf({ objectStream: { objects: [[20, js]] } }))).toBe('active_content');
  });

  it('does not read names out of stream data', () => {
    const pdf = samplePdf({
      extraObjects: ['<< /Length 12 /Filter /FlateDecode >>\nstream\n/JS /Launch \nendstream'],
    });
    expect(inspectPdf(pdf)).toBe('ok');
  });
});

describe('inspectPdf: the tokenised scan', { timeout: 60_000 }, () => {
  it('takes linear time: a file of repeated stream keywords is refused at once', () => {
    const pdf = Buffer.from(`%PDF-1.7\n${' stream\n'.repeat(256 * 1024)}%%EOF\n`, 'latin1');
    expect(pdf.length).toBeGreaterThan(2 * 1024 * 1024);
    const run = measured(() => inspectPdf(pdf));
    expect(run.result).toBe('not_a_document');
    expect(run.ms).toBeLessThan(1000);
    // Many short, well-formed streams: still linear.
    const many = samplePdf({
      extraObjects: Array.from(
        { length: 20_000 },
        () => '<< /Length 4 >>\nstream\nabcd\nendstream',
      ),
    });
    const again = measured(() => inspectPdf(many));
    expect(again.result).toBe('ok');
    expect(again.ms).toBeLessThan(1000);
  });

  it('refuses a stream with no endstream, and an unterminated string or dictionary', () => {
    expect(inspectPdf(samplePdf({ extraObjects: ['<< /Length 3 >>\nstream\nabc'] }))).toBe(
      'not_a_document',
    );
    expect(inspectPdf(samplePdf({ extraObjects: ['(never closed'] }))).toBe('not_a_document');
    expect(inspectPdf(samplePdf({ extraObjects: ['<< /A 1'] }))).toBe('not_a_document');
  });

  it('is not fooled by stream markers in comments, or names in strings and comments', () => {
    expect(
      inspectPdf(
        samplePdf({
          catalogExtra: '/OpenAction 5 0 R ',
          extraObjects: [`% stream\n${js}\n% endstream`],
        }),
      ),
    ).toBe('active_content');
    // Only text, not syntax: fine.
    expect(
      inspectPdf(samplePdf({ extraObjects: ['(a /JS name in a string)', '% /Launch\nnull'] })),
    ).toBe('ok');
  });

  it('decodes escaped names, also in an object stream’s type', () => {
    const escaped = samplePdf({ objectStream: { objects: [[20, js]], type: 'Obj#53tm' } });
    expect(inspectPdf(escaped)).toBe('active_content');
    expect(inspectPdf(samplePdf({ extraObjects: ['<< /S /#4Aava#53cript >>'] }))).toBe(
      'active_content',
    );
  });

  it('refuses an object stream with a predictor or another filter', () => {
    const member: [number, string][] = [[20, '<< /S /GoTo >>']];
    expect(
      inspectPdf(
        samplePdf({
          objectStream: { objects: member, dict: '/DecodeParms << /Predictor 12 /Columns 4 >>' },
        }),
      ),
    ).toBe('not_a_document');
    expect(inspectPdf(samplePdf({ objectStream: { objects: member, filter: '/LZWDecode' } }))).toBe(
      'not_a_document',
    );
    // An action inside, though nothing outside names it, is refused when opened.
    expect(
      inspectPdf(
        samplePdf({ catalogExtra: '/OpenAction 20 0 R ', objectStream: { objects: [[20, uri]] } }),
      ),
    ).toBe('active_content');
  });

  it('refuses additional actions, form submission, data import, remote go-to and action open-actions', () => {
    for (const pdf of [
      samplePdf({ extraObjects: ['<< /AA << /O 6 0 R >> >>'] }),
      samplePdf({ extraObjects: ['<< /S /SubmitForm /F (https://example.test) >>'] }),
      samplePdf({ extraObjects: ['<< /S /ImportData /F (data.fdf) >>'] }),
      samplePdf({ extraObjects: ['<< /S /GoToR /F (other.pdf) /D [0 /Fit] >>'] }),
      samplePdf({ catalogExtra: `/OpenAction ${uri} ` }),
      samplePdf({ catalogExtra: '/OpenAction 5 0 R ', extraObjects: [uri] }),
    ]) {
      expect(inspectPdf(pdf)).toBe('active_content');
    }
    // A destination is fine, given directly or by reference to an array.
    expect(inspectPdf(samplePdf({ catalogExtra: '/OpenAction [3 0 R /Fit] ' }))).toBe('ok');
    expect(
      inspectPdf(samplePdf({ catalogExtra: '/OpenAction 5 0 R ', extraObjects: ['[3 0 R /Fit]'] })),
    ).toBe('ok');
  });

  it('refuses objects hidden in stream data or behind a stream keyword that opens nothing', () => {
    // An action inside a stream's data (right /Length), which the cross-reference points at.
    const inner = `\n5 0 obj\n${js}\nendobj\n`;
    const hidden = rawPdf(
      [
        catalog(),
        pages,
        `\n4 0 obj\n<< /Length ${inner.length} >>\nstream\n${inner}\nendstream\nendobj\n`,
      ],
      6,
    );
    expect(inspectPdf(hidden)).toBe('not_a_document');
    // The same, compressed, so no `obj` shows in the data: the cross-reference gives it away.
    const packed = deflateSync(Buffer.from(inner, 'latin1'));
    const compressed = rawPdf(
      [
        catalog(),
        pages,
        `\n4 0 obj\n<< /Length ${packed.length} /Filter /FlateDecode >>\nstream\n${packed.toString('latin1')}\nendstream\nendobj\n`,
      ],
      5,
    ).toString('latin1');
    // Point the table at an offset inside the stream data.
    const into = compressed.indexOf('stream\n') + 10;
    const lying = Buffer.from(
      compressed
        .replace(/xref\n0 5\n/, `xref\n0 6\n`)
        .replace(/\ntrailer/, `\n${String(into).padStart(10, '0')} 00000 n \ntrailer`),
      'latin1',
    );
    expect(inspectPdf(lying)).toBe('not_a_document');
    // A bare `stream … endstream` between objects.
    expect(
      inspectPdf(rawPdf([catalog(), pages, `\nstream\n5 0 obj\n${js}\nendobj\nendstream\n`], 6)),
    ).toBe('not_a_document');
  });

  it('refuses stray delimiters and run-together tokens rather than guess', () => {
    // A stray `{` would put the scan and a reader out of step on which name is a key.
    expect(inspectPdf(rawPdf([catalog(`/X { /OpenAction ${uri} `), pages], 4))).toBe(
      'not_a_document',
    );
    // `5 0obj`: a reader may still find object 5 (an action the catalog opens).
    expect(inspectPdf(rawPdf([catalog(), pages, `\n5 0obj\n${uri}\nendobj\n`], 6))).toBe(
      'not_a_document',
    );
    expect(inspectPdf(rawPdf([catalog(), pages, `\n5 0 obj\n${uri}\nendobj\n`], 6))).toBe(
      'active_content',
    );
  });

  it('checks the cross-reference: tables, streams with a predictor, and incremental updates', () => {
    expect(inspectPdf(samplePdf({ xref: 'stream' }))).toBe('ok');
    expect(inspectPdf(samplePdf({ xref: 'stream-up' }))).toBe('ok');
    expect(
      inspectPdf(samplePdf({ xref: 'stream', objectStream: { objects: [[20, '<< /A 1 >>']] } })),
    ).toBe('ok');
    // An incremental update: a new object and a section that points back with /Prev.
    const base = samplePdf();
    const previous = /startxref\n(\d+)/.exec(base.toString('latin1'))![1];
    const objectAt = base.length;
    const added = '5 0 obj\n<< /Producer (synthetic update) >>\nendobj\n';
    const sectionAt = objectAt + added.length;
    const updated = Buffer.concat([
      base,
      Buffer.from(
        `${added}xref\n0 1\n0000000000 65535 f \n5 1\n${String(objectAt).padStart(10, '0')} 00000 n \ntrailer\n<< /Size 6 /Root 1 0 R /Prev ${previous} >>\nstartxref\n${sectionAt}\n%%EOF\n`,
        'latin1',
      ),
    ]);
    expect(inspectPdf(updated)).toBe('ok');
    // No cross-reference, one that does not parse, or an offset on no object: refused.
    const text = samplePdf().toString('latin1');
    for (const broken of [
      text.replace(/startxref\n\d+/, 'startxref\n999999'),
      text.replace('0000000015 00000 n', '00000000-1 00000 n'),
      text.replace(
        /\n(\d{10}) 00000 n /,
        (_, o: string) => `\n${String(Number(o) + 3).padStart(10, '0')} 00000 n `,
      ),
      text.replace(/startxref\n\d+\n/, ''),
    ]) {
      expect(inspectPdf(Buffer.from(broken, 'latin1'))).toBe('not_a_document');
    }
    // A packed object in a stream that is not there.
    const missing = samplePdf({ xref: 'stream', objectStream: { objects: [[20, '<< >>']] } });
    expect(
      inspectPdf(
        Buffer.from(missing.toString('latin1').replace('/Type /ObjStm', '/Type /ObjStX'), 'latin1'),
      ),
    ).toBe('not_a_document');
  });

  /**
   * A PDF with objects 1–3 (the catalog opening object 7), an object stream 4 holding
   * objects 6 and 7 at the offsets `header` gives, `extra` objects, and a cross-reference
   * stream (number 5) mapping 6 and 7 into object stream 4.
   */
  function packedPdf(header: string, objects: string, extra: string[] = []): Buffer {
    const parts: Buffer[] = [Buffer.from('%PDF-1.7\n', 'latin1')];
    let length = parts[0]!.length;
    const offsets: number[] = [];
    const push = (chunk: Buffer) => {
      parts.push(chunk);
      length += chunk.length;
    };
    const object = (num: number, body: string | Buffer) => {
      offsets[num] = length;
      push(
        Buffer.concat([
          Buffer.from(`${num} 0 obj\n`),
          Buffer.from(body as string, 'latin1'),
          Buffer.from('\nendobj\n'),
        ]),
      );
    };
    object(1, '<< /Type /Catalog /Pages 2 0 R /OpenAction 7 0 R >>');
    object(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
    object(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>');
    const packed = deflateSync(Buffer.from(header + objects, 'latin1'));
    offsets[4] = length;
    push(
      Buffer.concat([
        Buffer.from(
          `4 0 obj\n<< /Type /ObjStm /N 2 /First ${header.length} /Filter /FlateDecode /Length ${packed.length} >>\nstream\n`,
        ),
        packed,
        Buffer.from('\nendstream\nendobj\n'),
      ]),
    );
    for (const chunk of extra) push(Buffer.from(chunk, 'latin1'));
    offsets[5] = length;
    const row = (kind: number, a: number, b: number) =>
      Buffer.from([
        kind,
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
      ]),
    );
    push(
      Buffer.concat([
        Buffer.from(
          `5 0 obj\n<< /Type /XRef /Size 8 /W [1 4 2] /Root 1 0 R /Filter /FlateDecode /Length ${rows.length} >>\nstream\n`,
        ),
        rows,
        Buffer.from(`\nendstream\nendobj\nstartxref\n${offsets[5]}\n%%EOF\n`),
      ]),
    );
    return Buffer.concat(parts);
  }

  it('requires an object stream’s objects to start at top-level tokens, in order', () => {
    // The control: object 7 starts after object 6, and is the action the catalog opens.
    const six = 'null ';
    expect(inspectPdf(packedPdf(`6 0 7 ${six.length} `, six + js))).toBe('active_content');
    // Object 7 inside a string of object 6, or inside a comment: the in-order scan never
    // reads it, a reader following the header does.
    const inString = `(${js})`;
    expect(inspectPdf(packedPdf(`6 0 7 1 `, inString))).toBe('not_a_document');
    const inComment = `null % ${js}\n`;
    expect(inspectPdf(packedPdf(`6 0 7 7 `, inComment))).toBe('not_a_document');
    // Offsets that go backwards or repeat.
    expect(inspectPdf(packedPdf(`6 5 7 0 `, `null ${js}`))).toBe('not_a_document');
    expect(inspectPdf(packedPdf(`6 0 7 0 `, `null ${js}`))).toBe('not_a_document');
  });

  it('refuses a stream whose layout is given by reference, and a container the scan did not read', () => {
    // A second object 4, typed /ObjStm through object 9, with the script in plain data.
    const hidden = `null ${js}`;
    const second = `4 0 obj\n<< /Type 9 0 R /N 2 /First 8 /Length ${hidden.length + 8} >>\nstream\n6 0 7 5 ${hidden}\nendstream\nendobj\n9 0 obj\n/ObjStm\nendobj\n`;
    expect(inspectPdf(packedPdf('6 0 7 5 ', 'null null', [second]))).toBe('not_a_document');
    for (const key of [
      '/Filter 9 0 R',
      '/N 9 0 R',
      '/First 9 0 R',
      '/W [1 9 0 R 2]',
      '/Index 9 0 R',
      '/DecodeParms 9 0 R',
    ]) {
      const pdf = samplePdf({
        extraObjects: [`<< ${key} /Length 4 >>\nstream\nabcd\nendstream`],
      });
      expect(inspectPdf(pdf), key).toBe('not_a_document');
    }
    // An indirect /Length is fine (common in real files).
    expect(
      inspectPdf(
        samplePdf({ extraObjects: ['<< /Length 6 0 R >>\nstream\nabcd\nendstream', '4'] }),
      ),
    ).toBe('ok');
  });

  it('bounds the cross-reference: at most 1,000,000 entries, raw data charged to the budget', () => {
    const xrefOnly = (rows: Buffer, size: number, flate: boolean) => {
      const body = flate ? deflateSync(rows, { level: 9 }) : rows;
      return Buffer.concat([
        Buffer.from(
          `%PDF-1.7\n1 0 obj\n<< /Type /XRef /Size ${size} /W [1 0 0] ${flate ? '/Filter /FlateDecode' : ''} /Length ${body.length} >>\nstream\n`,
        ),
        body,
        Buffer.from('\nendstream\nendobj\nstartxref\n9\n%%EOF\n'),
      ]);
    };
    const big = 32 * 1024 * 1024 - 64;
    for (const [name, pdf] of [
      ['32M type-1 rows from 32 KB', xrefOnly(Buffer.alloc(big, 1), big, true)],
      ['32M type-2 rows from 32 KB', xrefOnly(Buffer.alloc(big, 2), big, true)],
      ['20 MB of raw rows', xrefOnly(Buffer.alloc(20 * 1024 * 1024, 1), 20 * 1024 * 1024, false)],
      ['a million free entries', xrefOnly(Buffer.alloc(1_000_000, 0), 1_000_000, true)],
    ] as const) {
      const run = measured(() => inspectPdf(pdf));
      expect(run.ms, name).toBeLessThan(1000);
      expect(run.mb, name).toBeLessThan(128);
    }
    expect(inspectPdf(xrefOnly(Buffer.alloc(1_000_001, 0), 1_000_001, true))).toBe(
      'not_a_document',
    );
  });

  it('refuses encrypted PDFs as such', () => {
    expect(inspectPdf(samplePdf({ trailerExtra: '/Encrypt 9 0 R ' }))).toBe('encrypted');
    expect(inspectPdf(samplePdf({ xref: 'stream', trailerExtra: '/Encrypt 9 0 R ' }))).toBe(
      'encrypted',
    );
  });

  it('bounds an object stream’s header, the number of object streams and the length of names', () => {
    // A 32 MB header of "1 1" pairs, from a few kilobytes.
    const header = Buffer.from('1 1 '.repeat(8 * 1024 * 1024 - 16));
    const packed = deflateSync(header, { level: 9 });
    const bomb = Buffer.concat([
      Buffer.from(
        `%PDF-1.7\n1 0 obj\n<< /Type /ObjStm /N 1 /First ${header.length} /Filter /FlateDecode /Length ${packed.length} >>\nstream\n`,
      ),
      packed,
      Buffer.from('\nendstream\nendobj\n%%EOF\n'),
    ]);
    const headerRun = measured(() => inspectPdf(bomb));
    expect(headerRun.result).toBe('not_a_document');
    expect(headerRun.ms).toBeLessThan(1000);
    expect(headerRun.mb).toBeLessThan(128);
    // /N beyond 10,000, or a header that is not exactly /N pairs.
    for (const dict of ['/N 10001 /First 4', '/N 2 /First 4']) {
      const pdf = samplePdf({ objectStream: { objects: [[20, '<< >>']] } }).toString('latin1');
      expect(inspectPdf(Buffer.from(pdf.replace(/\/N 1 \/First \d+/, dict), 'latin1'))).toBe(
        'not_a_document',
      );
    }
    // More than 10,000 object streams.
    const tiny = deflateSync(Buffer.from('1 0 null'));
    const one = Buffer.concat([
      Buffer.from(
        `1 0 obj\n<< /Type /ObjStm /N 1 /First 4 /Filter /FlateDecode /Length ${tiny.length} >>\nstream\n`,
      ),
      tiny,
      Buffer.from('\nendstream\nendobj\n'),
    ]);
    const many = Buffer.concat([
      Buffer.from('%PDF-1.7\n'),
      ...Array<Buffer>(10_001).fill(one),
      Buffer.from('%%EOF\n'),
    ]);
    const manyRun = measured(() => inspectPdf(many));
    expect(manyRun.result).toBe('not_a_document');
    expect(manyRun.ms).toBeLessThan(1000);
    // A 20 MB name.
    const name = Buffer.from(`%PDF-1.7\n/${'A#41'.repeat(5_000_000)}\n%%EOF\n`, 'latin1');
    const nameRun = measured(() => inspectPdf(name));
    expect(nameRun.result).toBe('not_a_document');
    expect(nameRun.ms).toBeLessThan(1000);
    expect(nameRun.mb).toBeLessThan(128);
    expect(inspectPdf(samplePdf({ extraObjects: [`<< /${'N'.repeat(257)} 1 >>`] }))).toBe(
      'not_a_document',
    );
  });

  it('accepts the PDFs the platform itself renders, and pdf-lib output with and without object streams', async () => {
    const letter = (language: 'en' | 'hi') =>
      renderReferralLetterPdf({
        language,
        paperSize: 'a4',
        watermark: null,
        doctor: {
          name: 'Dr. Synthetic Doctor',
          qualifications: 'MBBS',
          specialty: 'Orthopaedics',
          registrationNumber: 'TEST-12345',
          council: 'Test Medical Council',
        },
        organisationName: 'Synthetic Clinic',
        clinic: { name: 'Main clinic', address: '1 Test Road', phone: null },
        date: '2026-10-08',
        visitDate: '2026-10-06',
        patient: {
          name: 'Asha Verma',
          age: { years: 41, months: 9 },
          gender: 'female',
          uhid: 'SY-000001',
        },
        recipient: { name: 'Dr Meera Iyer', specialty: null, hospital: null, phone: null },
        urgency: 'soon',
        reason: 'Synthetic reason.',
        notes: null,
        diagnoses: [],
        signature: {
          signedAt: new Date('2026-10-08T05:12:00Z'),
          method: 'test_key',
          certificate: 'TEST KEY ed25519 0000',
        },
        verificationUrl: 'https://app.test/verify/referral/ABCDEFGHJKMNPQRSTVWXYZ01',
      });
    expect(inspectPdf(await letter('en'))).toBe('ok');
    expect(inspectPdf(await letter('hi'))).toBe('ok');
    const lib = await PDFDocument.create();
    lib.addPage().drawText('Synthetic diet chart', {
      font: await lib.embedFont(StandardFonts.Helvetica),
    });
    expect(inspectPdf(Buffer.from(await lib.save({ useObjectStreams: true })))).toBe('ok');
    expect(inspectPdf(Buffer.from(await lib.save({ useObjectStreams: false })))).toBe('ok');
  });
});

describe('inspectDocument', () => {
  it('accepts still PNG, JPEG and WebP images of the type they were sent as', () => {
    expect(inspectDocument('png', samplePng())).toBe('png');
    expect(inspectDocument('jpeg', sampleJpeg())).toBe('jpeg');
    expect(inspectDocument('webp', sampleWebp())).toBe('webp');
    expect(inspectDocument('png', sampleJpeg())).toBe('type_mismatch');
    expect(inspectDocument('pdf', samplePng())).toBe('type_mismatch');
  });

  it('refuses SVG and HTML sent as an image, polyglots and animation', () => {
    expect(inspectDocument('png', SAMPLE_SVG)).toBe('not_a_document');
    expect(inspectDocument('png', Buffer.from('<!doctype html><p>synthetic</p>'))).toBe(
      'not_a_document',
    );
    expect(inspectDocument('png', Buffer.concat([samplePng(), samplePdf()]))).toBe(
      'not_a_document',
    );
    expect(inspectDocument('png', samplePng({ extra: [['acTL', Buffer.alloc(8)]] }))).toBe(
      'animated',
    );
  });

  it('allows a large photo but not one that decodes to a huge image', () => {
    expect(inspectDocument('jpeg', sampleJpeg({ width: 8000, height: 6000 }))).toBe('jpeg');
    expect(inspectDocument('jpeg', sampleJpeg({ width: 10_001, height: 10 }))).toBe(
      'too_many_pixels',
    );
    expect(inspectDocument('jpeg', sampleJpeg({ width: 9000, height: 9000 }))).toBe(
      'too_many_pixels',
    );
  });
});

describe('acceptDocument', () => {
  it('returns the type and the extension to store it under', () => {
    expect(reason('application/pdf', samplePdf())).toEqual({ type: 'pdf', extension: 'pdf' });
    expect(reason('image/webp', sampleWebp())).toEqual({ type: 'webp', extension: 'webp' });
    expect(reason('image/jpeg', sampleJpeg())).toEqual({ type: 'jpeg', extension: 'jpg' });
  });

  it('applies the clinic’s limits, and refuses SVG and HTML by name', () => {
    expect(reason('image/svg+xml', SAMPLE_SVG)).toBe('type_not_allowed');
    expect(reason('text/html', Buffer.from('<p>synthetic</p>'))).toBe('type_not_allowed');
    expect(reason('image/heic', Buffer.from('synthetic'))).toBe('type_not_allowed');
    expect(reason('image/png', samplePng(), { maxUploadMb: 1, uploadTypes: ['pdf'] })).toBe(
      'type_not_allowed',
    );
    expect(reason('application/pdf', Buffer.alloc(0))).toBe('empty');
    const big = Buffer.concat([samplePdf(), Buffer.alloc(1024 * 1024, 0x20)]);
    expect(reason('application/pdf', big)).toBe('too_large');
    expect(reason('application/pdf', samplePng())).toBe('type_mismatch');
    expect(reason('image/png', Buffer.concat([samplePng(), Buffer.from('<html>')]))).toBe(
      'not_a_document',
    );
  });
});
