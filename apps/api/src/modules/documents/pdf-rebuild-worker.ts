import { createRequire } from 'node:module';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { deflateSync } from 'node:zlib';
import {
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
 *    cross-reference streams into buffers outside the worker's capped heap, so its decoders
 *    are capped (`capDecoders`): all streams and filter stages of one rebuild together may
 *    decode to at most `maxDecodedBytes`, and a stream may chain at most `maxFilters`
 *    filters (a small file cannot inflate to gigabytes).
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
 *    value is a blocked name (`/S /JavaScript`, `/S /URI`, `/Type /EmbeddedFile`) is removed,
 *    a blocked name in an array or as an object of its own becomes `null`, and an object
 *    pdf-lib could not parse (which it would write back byte for byte) becomes `null`. Stream
 *    dictionaries lose their external-file keys (`/F`, `/FFilter`, `/FDecodeParms`) and a
 *    form's reference to another file's page (`/Ref`); XMP `/Metadata` goes everywhere.
 *    Stream data is copied as it is, except that a stream with no usable filter (none, an
 *    empty array, `null`, anything but names) is Flate-compressed, so no text of the
 *    upload's (an object hidden in a page's content, say) is left in plain view.
 * 5. The document is written with object streams off: a classic cross-reference table, every
 *    object in plain view. An output over `maxOutputBytes` is refused (`too_large`); otherwise
 *    it is checked by `checkOwnPdf` (`pdf-scan.ts`) and returned only if it passes. The same
 *    upload gives the same bytes for a given pdf-lib, Node and zlib version.
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
  'URI',
  'URL',
  'Metadata',
]);

/** Keys removed from stream dictionaries: data in another file, or another file's page. */
const STREAM_KEYS_DROPPED = ['F', 'FFilter', 'FDecodeParms', 'Ref'];

/** Limits of one rebuild (the worker's own; time and heap are set by `pdf-rebuild.ts`). */
export interface RewriteLimits {
  maxPages: number;
  /** Bytes all of pdf-lib's stream decoders together may produce. */
  maxDecodedBytes: number;
  /** Filters one stream may chain. */
  maxFilters: number;
  /** Largest output kept. */
  maxOutputBytes: number;
}

/** What the rebuild gives: the new file, or why the upload is refused. */
export type RewriteOutcome =
  | { ok: true; data: Uint8Array; pages: number }
  | {
      ok: false;
      /**
       * The upload's fault (`encrypted`, `too_many_pages`, `not_a_document`, `too_large`), or
       * ours (`unavailable`: the rebuild itself is broken).
       */
      reason: 'encrypted' | 'too_many_pages' | 'not_a_document' | 'too_large' | 'unavailable';
      detail: string;
    };

const PRODUCER = 'Digital Healthcare';

/** Bytes decoded so far in this rebuild, against `maxDecodedBytes`. */
const decoding = { used: 0, budget: Infinity, maxFilters: Infinity };

/**
 * Caps pdf-lib's stream decoders (point 1 above), in the copy of pdf-lib this thread loaded:
 * in the API, only the rebuild's worker. pdf-lib does not export its decoders, so the
 * CommonJS modules it is built from are patched: `ensureBuffer` of the decoders' base class
 * (every buffer a decoder grows, at every filter stage, is charged to the budget) and
 * `decodePDFRawStream` (which pdf-lib's parser calls through its module object, so the
 * wrapper is what it gets). Each patch is checked to take effect; if pdf-lib changed and it
 * does not, this throws, and the rebuild reports itself broken rather than run uncapped.
 */
export function setDecodeLimits(limits: Pick<RewriteLimits, 'maxDecodedBytes' | 'maxFilters'>) {
  decoding.used = 0;
  decoding.budget = limits.maxDecodedBytes;
  decoding.maxFilters = limits.maxFilters;
}

let capped = false;
export function capDecoders() {
  if (capped) return;
  const require = createRequire(import.meta.url);
  const lib = require('pdf-lib') as { PDFRawStream: unknown };
  const decodeModule = require('pdf-lib/cjs/core/streams/decode.js') as {
    decodePDFRawStream: (stream: PDFRawStream) => unknown;
  };
  const DecodeStream = (
    require('pdf-lib/cjs/core/streams/DecodeStream.js') as {
      default: { prototype: { ensureBuffer(requested: number): Uint8Array; buffer?: Uint8Array } };
    }
  ).default;
  const base = DecodeStream.prototype;
  const ensureBuffer = base.ensureBuffer;
  base.ensureBuffer = function (this: { buffer?: Uint8Array }, requested: number) {
    const before = this.buffer?.byteLength ?? 0;
    const buffer = ensureBuffer.call(this, requested);
    decoding.used += Math.max(0, buffer.byteLength - before);
    if (decoding.used > decoding.budget) throw new Error('decoded data over budget');
    return buffer;
  };
  const decode = decodeModule.decodePDFRawStream;
  decodeModule.decodePDFRawStream = (stream) => {
    const filter = stream.dict.lookup(PDFName.of('Filter'));
    if (filter instanceof PDFArray && filter.size() > decoding.maxFilters) {
      throw new Error('too many filters');
    }
    return decode(stream);
  };
  // Both patches must be the ones pdf-lib's parser uses (`ByteStream.fromPDFRawStream`, how
  // it reads object and cross-reference streams), on the classes this module imported.
  const ByteStream = (
    require('pdf-lib/cjs/core/parser/ByteStream.js') as {
      default: { fromPDFRawStream(stream: PDFRawStream): unknown };
    }
  ).default;
  const context = PDFContext.create();
  const probe = decode(
    PDFRawStream.of(context.obj({ Filter: 'FlateDecode' }), deflateSync(Buffer.alloc(0))),
  ) as unknown as object;
  const saved = { ...decoding };
  let chainCapped = false;
  try {
    decoding.maxFilters = 0;
    ByteStream.fromPDFRawStream(
      PDFRawStream.of(context.obj({ Filter: ['FlateDecode'] }), deflateSync(Buffer.alloc(0))),
    );
  } catch (error) {
    chainCapped = String(error).includes('too many filters');
  } finally {
    Object.assign(decoding, saved);
  }
  if (
    lib.PDFRawStream !== PDFRawStream ||
    !chainCapped ||
    !(probe instanceof (DecodeStream as unknown as new () => object))
  ) {
    throw new Error('pdf-lib decoders could not be capped');
  }
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
    // An unparsed object, or a blocked name as an object of its own (`/S 6 0 R`).
    if (object instanceof PDFInvalidObject || (object instanceof PDFName && isBlocked(object))) {
      context.assign(ref, PDFNull);
    } else {
      todo.push(object);
    }
  }
  const seen = new Set<PDFObject>();
  while (todo.length > 0) {
    const object = todo.pop()!;
    if (seen.has(object)) continue;
    seen.add(object);
    if (object instanceof PDFStream) {
      for (const key of STREAM_KEYS_DROPPED) object.dict.delete(PDFName.of(key));
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

/** Whether a stream has a filter a reader applies: a name, or a non-empty array of names. */
function hasFilter(stream: PDFRawStream) {
  const filter = stream.dict.lookup(PDFName.of('Filter'));
  if (filter instanceof PDFName) return true;
  if (!(filter instanceof PDFArray) || filter.size() === 0) return false;
  return filter.asArray().every((item) => stream.dict.context.lookup(item) instanceof PDFName);
}

/** Flate-compresses every stream with no usable filter (see above). */
function compressPlainStreams(context: PDFContext) {
  for (const [ref, object] of context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream) || hasFilter(object)) continue;
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
export async function rewritePdf(
  input: Uint8Array,
  limits: RewriteLimits,
): Promise<RewriteOutcome> {
  const { maxPages } = limits;
  const refuse = (reason: 'too_many_pages' | 'not_a_document' | 'too_large', detail: string) =>
    ({ ok: false, reason, detail }) as const;
  capDecoders();
  setDecodeLimits(limits);
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
    if (data.length > limits.maxOutputBytes) return refuse('too_large', `output ${data.length}`);
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
  limits: RewriteLimits;
}

// As a worker: rebuild the file it was given, post the outcome and end.
if (!isMainThread && parentPort && (workerData as RewriteJob | undefined)?.task === 'rebuild-pdf') {
  // pdf-lib warns on the console for each object it cannot parse: a hostile file has many.
  console.warn = () => {};
  const job = workerData as RewriteJob;
  const port = parentPort;
  rewritePdf(job.data, job.limits).then(
    (outcome) => port.postMessage(outcome, outcome.ok ? [outcome.data.buffer as ArrayBuffer] : []),
    // A fault of the rebuild itself (pdf-lib could not be capped, say): not the upload's.
    (error: unknown) =>
      port.postMessage({
        ok: false,
        reason: 'unavailable',
        detail: `worker: ${String(error)}`,
      } satisfies RewriteOutcome),
  );
}
