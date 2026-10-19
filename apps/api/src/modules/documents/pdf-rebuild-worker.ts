import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { deflateSync } from 'node:zlib';
import {
  decodePDFRawStream,
  ParseSpeeds,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFInvalidObject,
  PDFName,
  PDFNull,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFContext,
  type PDFObject,
} from 'pdf-lib';
import { checkOwnPdf } from './pdf-scan.ts';

/**
 * The rebuild of an uploaded PDF (threat model T27), run in a worker thread by
 * `pdf-rebuild.ts`. Instead of proving that an uploaded file is safe, the API keeps only its
 * pages and writes a new file of its own:
 *
 * 1. The upload is loaded with pdf-lib. Encrypted files are refused as such; files with no
 *    pages or more than `maxPages` are refused. While loading, pdf-lib inflates object and
 *    cross-reference streams into buffers outside the worker's capped heap, so no stream may
 *    decode to more than `MAX_DECODED` bytes (a small file cannot inflate to gigabytes).
 * 2. Each page dictionary is cut down to what draws the page (`PAGE_KEYS`: the boxes,
 *    rotation, resources, contents and transparency group), so annotations (links, form
 *    fields, stamps), page actions (`/AA`), thumbnails, metadata and structure are never
 *    copied. The pages are then copied into a new document (`copyPages`, which moves
 *    inherited resources and boxes onto the page and drops the link to the source's page
 *    tree) and cut down again there.
 * 3. Nothing of the source's catalog is copied: no `/OpenAction`, `/AA`, `/Names`
 *    (JavaScript, embedded files), `/AcroForm`, `/Outlines`, `/StructTreeRoot`,
 *    `/OCProperties`, `/OutputIntents` or XMP metadata. The new document's information
 *    dictionary holds only our producer name, and no dates, so the same upload always gives
 *    the same bytes.
 * 4. Objects the new pages do not reach are dropped. Every object that is left is walked
 *    (without recursion): keys in `BLOCKED` are removed from dictionaries, an entry whose
 *    value is a blocked name (`/S /JavaScript`, `/Type /EmbeddedFile`) is removed, a blocked
 *    name in an array becomes `null`, and an object pdf-lib could not parse (which it would
 *    write back byte for byte) becomes `null`. Stream data is copied as it is, except that a
 *    stream with no filter is Flate-compressed, so no text of the upload's (an object
 *    hidden in a page's content, say) is left in plain view.
 * 5. The document is written with object streams off: a classic cross-reference table, every
 *    object in plain view. The output is then checked by `checkOwnPdf` (`pdf-scan.ts`) and
 *    returned only if it passes.
 *
 * The file imports only pdf-lib, Node and `pdf-scan.ts`, and uses only type syntax Node can
 * strip, so the same file runs as a worker from source (vitest, tsx) and from the build.
 */

/** Page keys kept: those that draw the page. */
export const PAGE_KEYS = new Set([
  'Type',
  'Parent',
  'MediaBox',
  'CropBox',
  'BleedBox',
  'TrimBox',
  'ArtBox',
  'Rotate',
  'UserUnit',
  'Resources',
  'Contents',
  'Group',
]);

/**
 * Names that run something, submit or fetch data, open other files or carry one: none may
 * remain in the output, as a key or as a value.
 */
export const BLOCKED = new Set([
  'JS',
  'JavaScript',
  'Launch',
  'EmbeddedFile',
  'EmbeddedFiles',
  'RichMedia',
  'XFA',
  'GoToR',
  'GoToE',
  'SubmitForm',
  'ImportData',
  'AA',
  'OpenAction',
]);

/** What the rebuild gives: the new file, or why the upload is refused. */
export type RewriteOutcome =
  | { ok: true; data: Uint8Array; pages: number }
  | { ok: false; reason: 'encrypted' | 'too_many_pages' | 'not_a_document'; detail: string };

const PRODUCER = 'Digital Healthcare';

/** Most bytes one stream may decode to while the upload is loaded. */
export const MAX_DECODED = 64 * 1024 * 1024;

/**
 * Caps how far pdf-lib's stream decoders may grow their buffer. The decoders are not
 * exported, so the shared base class is found from a decoder pdf-lib hands out. Applied to
 * the copy of pdf-lib the calling thread loaded (in the API, only the rebuild's worker).
 */
let capped = false;
function capDecodedStreams() {
  if (capped) return;
  const probe = decodePDFRawStream(
    PDFRawStream.of(
      PDFContext.create().obj({ Filter: 'FlateDecode' }),
      deflateSync(Buffer.alloc(0)),
    ),
  );
  let proto: object | null = Object.getPrototypeOf(probe) as object | null;
  while (proto && !Object.prototype.hasOwnProperty.call(proto, 'ensureBuffer')) {
    proto = Object.getPrototypeOf(proto) as object | null;
  }
  if (!proto) throw new Error('pdf-lib decoders have no ensureBuffer to cap');
  const base = proto as { ensureBuffer(requested: number): Uint8Array };
  const ensureBuffer = base.ensureBuffer;
  base.ensureBuffer = function (this: unknown, requested: number) {
    if (requested > MAX_DECODED) throw new Error('stream decodes to too much data');
    return ensureBuffer.call(this, requested);
  };
  capped = true;
}

const isBlocked = (name: PDFName) => BLOCKED.has(name.decodeText());

/** Removes every key of a page dictionary but those that draw it. */
function cutPage(page: PDFDict) {
  for (const key of page.keys()) {
    if (!PAGE_KEYS.has(key.decodeText())) page.delete(key);
  }
}

/** Drops the objects the document's trailer does not reach (followed without recursion). */
function dropUnreachable(context: PDFContext) {
  const reached = new Set<PDFRef>();
  const todo: PDFObject[] = [];
  const { Root, Info } = context.trailerInfo;
  if (Root) todo.push(Root);
  if (Info) todo.push(Info);
  while (todo.length > 0) {
    const object = todo.pop()!;
    if (object instanceof PDFRef) {
      if (reached.has(object)) continue;
      reached.add(object);
      const target = context.lookup(object);
      if (target) todo.push(target);
    } else if (object instanceof PDFDict) {
      for (const [, value] of object.entries()) todo.push(value);
    } else if (object instanceof PDFArray) {
      for (let i = 0; i < object.size(); i++) todo.push(object.get(i));
    } else if (object instanceof PDFStream) {
      todo.push(object.dict);
    }
  }
  for (const [ref] of context.enumerateIndirectObjects()) {
    if (!reached.has(ref)) context.delete(ref);
  }
}

/** Removes blocked names and unparsed objects from every object left (see above). */
function neuter(context: PDFContext) {
  const todo: PDFObject[] = [];
  for (const [ref, object] of context.enumerateIndirectObjects()) {
    if (object instanceof PDFInvalidObject) context.assign(ref, PDFNull);
    else todo.push(object);
  }
  const seen = new Set<PDFObject>();
  while (todo.length > 0) {
    const object = todo.pop()!;
    if (seen.has(object)) continue;
    seen.add(object);
    if (object instanceof PDFStream) {
      todo.push(object.dict);
    } else if (object instanceof PDFDict) {
      for (const [key, value] of object.entries()) {
        if (
          isBlocked(key) ||
          (value instanceof PDFName && isBlocked(value)) ||
          value instanceof PDFInvalidObject
        ) {
          object.delete(key);
        } else {
          todo.push(value);
        }
      }
    } else if (object instanceof PDFArray) {
      for (let i = 0; i < object.size(); i++) {
        const value = object.get(i);
        if ((value instanceof PDFName && isBlocked(value)) || value instanceof PDFInvalidObject) {
          object.set(i, PDFNull);
        } else {
          todo.push(value);
        }
      }
    }
  }
}

/** Flate-compresses every stream that has no filter (see above). */
function compressPlainStreams(context: PDFContext) {
  for (const [ref, object] of context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream) || object.dict.has(PDFName.of('Filter'))) continue;
    const dict = object.dict.clone(context);
    dict.delete(PDFName.of('DecodeParms'));
    dict.set(PDFName.of('Filter'), PDFName.of('FlateDecode'));
    context.assign(ref, PDFRawStream.of(dict, deflateSync(object.contents)));
  }
}

/**
 * Rebuilds a PDF from its pages (above). Throws only on a fault of its own; anything wrong
 * with the upload is an outcome.
 */
export async function rewritePdf(input: Uint8Array, maxPages: number): Promise<RewriteOutcome> {
  const refuse = (reason: 'too_many_pages' | 'not_a_document', detail: string) =>
    ({ ok: false, reason, detail }) as const;
  capDecodedStreams();
  let source: PDFDocument;
  try {
    // Loaded even when encrypted, to tell that case apart (pdf-lib's own error for it is not
    // an instance of its class once compiled).
    source = await PDFDocument.load(input, {
      parseSpeed: ParseSpeeds.Fastest,
      updateMetadata: false,
      throwOnInvalidObject: false,
      ignoreEncryption: true,
    });
  } catch (error) {
    return refuse('not_a_document', `load: ${String(error)}`);
  }
  if (source.isEncrypted) return { ok: false, reason: 'encrypted', detail: 'encrypted' };
  try {
    // The page tree's own count first, so a huge tree is refused before it is walked.
    const count = source.catalog.Pages().lookupMaybe(PDFName.of('Count'), PDFNumber);
    if (count && count.asNumber() > maxPages) {
      return refuse('too_many_pages', `count ${count.asNumber()}`);
    }
    const pages = source.getPages();
    if (pages.length === 0) return refuse('not_a_document', 'no pages');
    if (pages.length > maxPages) return refuse('too_many_pages', `pages ${pages.length}`);
    for (const page of pages) cutPage(page.node);

    const output = await PDFDocument.create({ updateMetadata: false });
    output.setProducer(PRODUCER);
    const copied = await output.copyPages(
      source,
      pages.map((_, i) => i),
    );
    for (const page of copied) {
      cutPage(page.node);
      output.addPage(page);
    }
    dropUnreachable(output.context);
    neuter(output.context);
    compressPlainStreams(output.context);
    const data = await output.save({
      useObjectStreams: false,
      addDefaultPage: false,
      updateFieldAppearances: false,
      // Nothing else runs on this thread: no need to yield every 50 objects.
      objectsPerTick: Infinity,
    });
    const problem = checkOwnPdf(data);
    if (problem) return refuse('not_a_document', `post-check: ${problem}`);
    return { ok: true, data, pages: copied.length };
  } catch (error) {
    return refuse('not_a_document', `rebuild: ${String(error)}`);
  }
}

/** The message a worker is started with. */
export interface RewriteJob {
  task: 'rebuild-pdf';
  data: Uint8Array;
  maxPages: number;
}

// As a worker: rebuild the file it was given, post the outcome and end.
if (!isMainThread && parentPort && (workerData as RewriteJob | undefined)?.task === 'rebuild-pdf') {
  // pdf-lib warns on the console for each object it cannot parse: a hostile file has many.
  console.warn = () => {};
  const job = workerData as RewriteJob;
  const port = parentPort;
  rewritePdf(job.data, job.maxPages).then(
    (outcome) => port.postMessage(outcome, outcome.ok ? [outcome.data.buffer as ArrayBuffer] : []),
    (error: unknown) =>
      port.postMessage({
        ok: false,
        reason: 'not_a_document',
        detail: `worker: ${String(error)}`,
      } satisfies RewriteOutcome),
  );
}
