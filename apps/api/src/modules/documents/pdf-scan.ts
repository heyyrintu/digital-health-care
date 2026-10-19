import { inflateSync } from 'node:zlib';

/**
 * A scan of a PDF's syntax for active content (threat model T27), used by `inspectPdf`.
 *
 * **Tokens.** The file is tokenised the way a reader does, in one pass, honouring comments,
 * literal and hex strings, dictionaries and arrays, so text that only looks like PDF syntax
 * (a `stream` keyword in a comment, `/JS` inside a string) is read as what it is. Outside
 * stream data only numbers, names, strings, `<<`/`>>`, `[`/`]` and the file-structure
 * keywords (`obj`, `endobj`, `stream`, `endstream`, `R`, `true`, `false`, `null`, `xref`,
 * `trailer`, `startxref`, `f`, `n`) are allowed: anything else (a stray `{`, `5 0obj`) is
 * refused rather than guessed at. Names longer than 256 bytes are refused.
 *
 * **Streams.** A `stream` keyword is accepted only straight after the dictionary of the
 * object being read; its data is skipped by a direct `/Length` that ends at `endstream`, else
 * up to the next `endstream` (none: refused). Data with no filter must not contain an
 * `n g obj` header (an object hidden in it).
 *
 * **Cross-reference.** Readers find objects by the cross-reference, not by reading the file
 * in order, so the scan checks it: from `startxref`, every section (classic tables and
 * cross-reference streams, Flate with or without a PNG predictor, `/W` and `/Index`), along
 * `/Prev` and `/XRefStm` (at most 64 sections), must parse, and every object in use must be
 * one the scan read: a type-1 offset must land on an `n g obj` it saw outside stream data
 * (with the same number and generation), and a type-2 entry must name an object stream it
 * inflated, within its `/N`. A missing or unreadable cross-reference, or one that points
 * anywhere else, is refused. Encrypted files (`/Encrypt`) are refused as such.
 *
 * **Active content** refused: the names `/JS`, `/JavaScript`, `/Launch`, `/EmbeddedFile(s)`,
 * `/RichMedia`, `/XFA`, `/AA` (additional actions), `/SubmitForm`, `/ImportData`, `/GoToR`
 * and `/GoToE`, with `#xx` escapes decoded, anywhere outside stream data; and an
 * `/OpenAction` that is an action (a dictionary, or a reference to an object whose
 * dictionary has an `/S` action type) rather than a destination (an array). Compressed
 * object streams (`/Type /ObjStm`, Flate only, no predictor; at most 10,000 of them, each
 * with `/N` up to 10,000 and `/First` up to 64 KB) are inflated, up to 32 MB in all, and
 * scanned the same way.
 *
 * Every step looks at each byte a bounded number of times, so the time is linear in the
 * file's size, and memory is bounded by the caps above.
 */

export type PdfScanResult = 'ok' | 'not_a_document' | 'active_content' | 'encrypted';

/** PDF names that run something, submit or fetch data, open other files or carry one. */
const ACTIVE_NAMES = new Set([
  'JS',
  'JavaScript',
  'Launch',
  'EmbeddedFile',
  'EmbeddedFiles',
  'RichMedia',
  'XFA',
  'AA',
  'SubmitForm',
  'ImportData',
  'GoToR',
  'GoToE',
]);

/** The file-structure keywords allowed outside stream data. */
const KEYWORDS = new Set([
  'obj',
  'endobj',
  'stream',
  'endstream',
  'R',
  'true',
  'false',
  'null',
  'xref',
  'trailer',
  'startxref',
  'f',
  'n',
]);
/** Keywords an object stream may not hold: it holds objects' values only. */
const NOT_IN_OBJECT_STREAMS = new Set([
  'obj',
  'endobj',
  'stream',
  'endstream',
  'xref',
  'trailer',
  'startxref',
]);

/** All the inflated streams of a PDF (object and cross-reference streams) add up to this. */
const MAX_INFLATED = 32 * 1024 * 1024;
/** Longest name or other token, in bytes, before decoding. */
const MAX_TOKEN = 256;
/** Object streams per file, objects per object stream, and the size of one's header. */
const MAX_OBJECT_STREAMS = 10_000;
const MAX_OBJECT_STREAM_N = 10_000;
const MAX_OBJECT_STREAM_FIRST = 64 * 1024;
/** Cross-reference sections followed along `/Prev` and `/XRefStm`. */
const MAX_XREF_SECTIONS = 64;

const isWhitespace = (c: number) =>
  c === 0x00 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d || c === 0x20;
const isDelimiter = (c: number) =>
  c === 0x28 ||
  c === 0x29 ||
  c === 0x3c ||
  c === 0x3e ||
  c === 0x5b ||
  c === 0x5d ||
  c === 0x7b ||
  c === 0x7d ||
  c === 0x2f ||
  c === 0x25;
const isRegular = (c: number) => !isWhitespace(c) && !isDelimiter(c);
const isDigit = (c: number) => c >= 0x30 && c <= 0x39;
const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)$/;

/** The top-level dictionary of an object (or a trailer), as far as the checks need it. */
interface Dict {
  type?: string;
  filters: string[];
  decodeParms: boolean;
  /** `/DecodeParms` given as something other than one dictionary. */
  decodeParmsOther: boolean;
  parms: Record<string, number>;
  length?: number;
  first?: number;
  n?: number;
  prev?: number;
  xrefStm?: number;
  size?: number;
  w: number[];
  index: number[];
  encrypt: boolean;
  /** A key the checks rely on (`/Type`, `/Filter`, `/N`, …) was given by reference. */
  indirect: boolean;
}
const newDict = (): Dict => ({
  filters: [],
  decodeParms: false,
  decodeParmsOther: false,
  parms: {},
  w: [],
  index: [],
  encrypt: false,
  indirect: false,
});

/** Keys whose value the checks read: given by reference, the stream cannot be vouched for. */
const DIRECT_KEYS = new Set(['Type', 'Filter', 'N', 'First', 'W', 'Index', 'DecodeParms']);

interface StreamObject {
  num: number;
  gen: number;
  /** Where its `n g obj` starts. */
  offset: number;
  dict: Dict;
  start: number;
  end: number;
}

interface Found {
  data: Buffer;
  active: boolean;
  broken: boolean;
  /** `/OpenAction` given as a dictionary (an action). */
  openActionDirect: boolean;
  /** Objects `/OpenAction` refers to. */
  openActionRefs: Set<number>;
  /** Objects whose top-level dictionary has an `/S` key: actions. */
  actions: Set<number>;
  /** `n g obj` headers seen outside stream data, by the offset of `n`. */
  objects: Map<number, { num: number; gen: number }>;
  /** Streams of objects, by the offset of their `n g obj`. */
  streams: Map<number, StreamObject>;
  objectStreams: StreamObject[];
  /** Trailer dictionaries, by the offset of their `trailer` keyword. */
  trailers: Map<number, Dict>;
}

const decodeName = (raw: string) =>
  raw.replace(/#([0-9a-fA-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));

/**
 * Whether stream data with no filter holds an `n g obj` header: an object hidden where the
 * scan does not look but a reader following the cross-reference would. Each `obj` is found
 * by a forward search and checked by looking back a bounded distance.
 */
function hidesObject(text: string, start: number, end: number): boolean {
  let at = start;
  for (;;) {
    const found = text.indexOf('obj', at);
    if (found < 0 || found + 3 > end) return false;
    at = found + 3;
    let k = found - 1;
    const stop = Math.max(start, found - 48);
    const run = (test: (c: number) => boolean) => {
      const from = k;
      while (k >= stop && test(text.charCodeAt(k))) k--;
      return from - k;
    };
    if (run(isWhitespace) && run(isDigit) && run(isWhitespace) && run(isDigit)) return true;
  }
}

/**
 * Scans `text` (a PDF, or an object stream's objects with `starts` giving where each
 * object begins) and records what it finds. Stops at the first sign the file is broken.
 */
function scan(
  text: string,
  found: Found,
  starts: { offset: number; num: number }[] = [],
  inObjectStream = false,
): Set<number> {
  // The header offsets of an object stream that a token at the top level starts at.
  const wanted = new Set(starts.map((s) => s.offset));
  const hit = new Set<number>();
  const n = text.length;
  let i = 0;
  let depth = 0;
  let arrays = 0;
  let current: number | null = null;
  let currentGen = 0;
  let currentOffset = -1;
  let dict: Dict | null = null;
  // The key at the top level of the object's dictionary whose value comes next.
  let key: string | null = null;
  // An array that is the value of `key` (its nesting level), or null.
  let arrayKey: string | null = null;
  let arrayLevel = 0;
  // Inside `/DecodeParms << … >>` (depth 2), and the key there.
  let inParms = false;
  let parmsKey: string | null = null;
  let lastNumericKey: string | null = null;
  // The last two tokens, when they were integers (for `n g obj` and `n g R`).
  let prev1: { value: number; start: number } | null = null;
  let prev2: { value: number; start: number } | null = null;
  // The object's top-level dictionary has just closed: a `stream` may follow.
  let afterDict = false;
  let pendingTrailer: number | null = null;
  let nextStart = 0;
  const broken = () => {
    found.broken = true;
    return hit;
  };

  const topLevel = () => depth === 1 && arrayKey === null;
  const setValue = (name: string | null, num: number | null) => {
    if (!dict || key === null) return;
    if (key === 'Type' && name) dict.type = name;
    else if (key === 'Filter' && name) dict.filters = [name];
    else if (key === 'DecodeParms' && (name !== 'null' || num !== null)) dict.decodeParms = true;
    else if (num !== null) {
      if (key === 'Length') dict.length = num;
      else if (key === 'First') dict.first = num;
      else if (key === 'N') dict.n = num;
      else if (key === 'Prev') dict.prev = num;
      else if (key === 'XRefStm') dict.xrefStm = num;
      else if (key === 'Size') dict.size = num;
      else if (key === 'OpenAction') found.openActionRefs.add(num);
    }
    lastNumericKey = num !== null ? key : null;
    key = null;
  };

  while (i < n && !found.broken) {
    // The next object of an object stream starts here.
    while (nextStart < starts.length && i >= starts[nextStart]!.offset && depth === 0) {
      current = starts[nextStart]!.num;
      dict = null;
      nextStart++;
    }
    const c = text.charCodeAt(i);
    if (isWhitespace(c)) {
      i++;
      continue;
    }
    if (c === 0x25) {
      // A comment runs to the end of the line.
      while (i < n && text.charCodeAt(i) !== 0x0a && text.charCodeAt(i) !== 0x0d) i++;
      continue;
    }
    const tokenStart = i;
    // An object of an object stream must start where a top-level token does, not inside a
    // string or a comment the scan skipped.
    if (depth === 0 && arrays === 0 && wanted.has(tokenStart)) hit.add(tokenStart);
    const wasAfterDict = afterDict;
    afterDict = false;
    if (c === 0x28) {
      // A literal string: balanced parentheses, backslash escapes.
      let level = 1;
      i++;
      while (i < n && level > 0) {
        const s = text.charCodeAt(i);
        if (s === 0x5c) i += 2;
        else {
          if (s === 0x28) level++;
          else if (s === 0x29) level--;
          i++;
        }
      }
      if (level > 0) return broken();
      if (topLevel()) setValue(null, null);
      prev1 = prev2 = null;
      continue;
    }
    if (c === 0x3c) {
      if (text.charCodeAt(i + 1) === 0x3c) {
        i += 2;
        depth++;
        if (depth === 1 && arrays === 0) {
          dict = newDict();
          key = null;
          arrayKey = null;
          if (pendingTrailer !== null) {
            found.trailers.set(pendingTrailer, dict);
            pendingTrailer = null;
          }
        } else if (depth === 2 && arrayKey === null && key !== null) {
          // A dictionary as the value of a top-level key.
          if (key === 'OpenAction') found.openActionDirect = true;
          if (key === 'DecodeParms' && dict) {
            dict.decodeParms = true;
            inParms = true;
            parmsKey = null;
          }
        } else if (depth === 2 && arrayKey === 'DecodeParms' && dict) {
          dict.decodeParmsOther = true;
        }
      } else {
        // A hex string.
        const end = text.indexOf('>', i + 1);
        if (end < 0) return broken();
        i = end + 1;
        if (topLevel()) setValue(null, null);
      }
      prev1 = prev2 = null;
      continue;
    }
    if (c === 0x3e) {
      if (text.charCodeAt(i + 1) !== 0x3e || depth === 0) return broken();
      i += 2;
      depth--;
      // A nested dictionary that was a key's value has ended.
      if (depth === 1 && arrayKey === null) {
        key = null;
        inParms = false;
      }
      if (depth === 0 && arrays === 0 && current !== null && dict) afterDict = true;
      prev1 = prev2 = null;
      continue;
    }
    if (c === 0x5b) {
      i++;
      arrays++;
      if (depth === 1 && arrayKey === null && key !== null) {
        if (key === 'DecodeParms' && dict) dict.decodeParms = true;
        arrayKey = key;
        arrayLevel = arrays;
        if (key === 'Filter' && dict) dict.filters = [];
      }
      prev1 = prev2 = null;
      continue;
    }
    if (c === 0x5d) {
      if (arrays === 0) return broken();
      i++;
      if (arrayKey !== null && arrays === arrayLevel) {
        arrayKey = null;
        key = null;
      }
      arrays--;
      prev1 = prev2 = null;
      continue;
    }
    if (c === 0x2f) {
      let end = i + 1;
      while (end < n && isRegular(text.charCodeAt(end))) end++;
      if (end - i - 1 > MAX_TOKEN) return broken();
      const name = decodeName(text.slice(i + 1, end));
      i = end;
      if (ACTIVE_NAMES.has(name)) found.active = true;
      if (topLevel()) {
        if (key === null) {
          key = name;
          lastNumericKey = null;
          if (name === 'S' && current !== null) found.actions.add(current);
          if (name === 'Encrypt' && dict) dict.encrypt = true;
        } else setValue(name, null);
      } else if (inParms && depth === 2) {
        parmsKey = parmsKey === null ? name : null;
      } else if (arrayKey === 'Filter' && depth === 1 && arrays === arrayLevel && dict) {
        dict.filters.push(name);
      }
      prev1 = prev2 = null;
      continue;
    }
    if (!isRegular(c)) {
      // A stray `)`, `{` or `}`: not PDF outside stream data.
      return broken();
    }
    let end = i + 1;
    while (end < n && isRegular(text.charCodeAt(end))) end++;
    if (end - i > MAX_TOKEN) return broken();
    const token = text.slice(i, end);
    i = end;
    if (NUMBER.test(token)) {
      const integer = /^\d+$/.test(token) ? Number(token) : null;
      if (integer !== null) {
        if (topLevel() && key !== null) setValue(null, integer);
        else if (inParms && depth === 2 && parmsKey !== null && dict) {
          dict.parms[parmsKey] = integer;
          parmsKey = null;
        } else if (
          (arrayKey === 'W' || arrayKey === 'Index') &&
          depth === 1 &&
          arrays === arrayLevel &&
          dict
        ) {
          (arrayKey === 'W' ? dict.w : dict.index).push(integer);
        }
        prev2 = prev1;
        prev1 = { value: integer, start: tokenStart };
      } else {
        if (topLevel() && key !== null) setValue(null, null);
        prev1 = prev2 = null;
      }
      continue;
    }
    if (!KEYWORDS.has(token) || (inObjectStream && NOT_IN_OBJECT_STREAMS.has(token))) {
      return broken();
    }
    if (token === 'obj') {
      if (!prev2 || !prev1 || depth !== 0 || arrays !== 0) return broken();
      current = prev2.value;
      currentGen = prev1.value;
      currentOffset = prev2.start;
      found.objects.set(currentOffset, { num: current, gen: currentGen });
      dict = null;
    } else if (token === 'endobj') {
      current = null;
      dict = null;
    } else if (token === 'xref' || token === 'trailer' || token === 'startxref') {
      current = null;
      dict = null;
      if (token === 'trailer') pendingTrailer = tokenStart;
    } else if (token === 'R') {
      // `n g R` was a reference: a `/Length` given that way is not a length.
      if (lastNumericKey === 'Length' && dict) dict.length = undefined;
      if (dict && depth === 1) {
        if (lastNumericKey !== null && DIRECT_KEYS.has(lastNumericKey)) dict.indirect = true;
        if (arrayKey !== null && DIRECT_KEYS.has(arrayKey)) dict.indirect = true;
      }
      lastNumericKey = null;
    } else if (token === 'stream') {
      // Only straight after the dictionary of the object being read.
      if (!wasAfterDict || !dict || current === null) return broken();
      let start = i;
      if (text.charCodeAt(start) === 0x0d) start++;
      if (text.charCodeAt(start) === 0x0a) start++;
      let dataEnd = -1;
      const length = dict.length;
      if (length !== undefined && start + length <= n) {
        let after = start + length;
        while (after < n && isWhitespace(text.charCodeAt(after))) after++;
        if (text.startsWith('endstream', after)) {
          dataEnd = start + length;
          i = after + 'endstream'.length;
        }
      }
      if (dataEnd < 0) {
        const endstream = text.indexOf('endstream', start);
        if (endstream < 0) return broken();
        dataEnd = endstream;
        i = endstream + 'endstream'.length;
      }
      // An object hidden in data no filter changes.
      if (dict.filters.length === 0 && hidesObject(text, start, dataEnd)) return broken();
      // A stream whose type, filter or layout is given by reference cannot be vouched for.
      if (dict.indirect) return broken();
      const stream = {
        num: current,
        gen: currentGen,
        offset: currentOffset,
        dict,
        start,
        end: dataEnd,
      };
      found.streams.set(currentOffset, stream);
      if (dict.type === 'ObjStm') {
        if (found.objectStreams.length >= MAX_OBJECT_STREAMS) return broken();
        found.objectStreams.push(stream);
      }
    } else if (token === 'endstream') {
      // Only after stream data, which is skipped above.
      return broken();
    } else if (topLevel() && key !== null) {
      // `true`, `false`, `null` as a value.
      setValue(token, null);
    }
    prev1 = prev2 = null;
  }
  if (depth !== 0 || arrays !== 0) broken();
  return hit;
}

/** Inflates a stream's data within `budget` bytes; null when it cannot be read. */
function inflate(data: Buffer, stream: StreamObject, budget: number): Buffer | null {
  if (budget <= 0) return null;
  try {
    return inflateSync(data.subarray(stream.start, stream.end), {
      maxOutputLength: budget,
      finishFlush: 2, // Z_SYNC_FLUSH: tolerate the end-of-line before `endstream`.
    });
  } catch {
    return null;
  }
}

/**
 * An object stream's header: exactly `count` pairs of object number and offset before
 * `first`, read digit by digit; null when it is anything else.
 */
function objectStreamHeader(
  objects: Buffer,
  first: number,
  count: number,
): { offset: number; num: number }[] | null {
  const out: { offset: number; num: number }[] = [];
  let at = 0;
  const integer = () => {
    while (at < first && isWhitespace(objects[at]!)) at++;
    let digits = 0;
    let value = 0;
    while (at < first && isDigit(objects[at]!) && digits < 10) {
      value = value * 10 + objects[at]! - 0x30;
      at++;
      digits++;
    }
    return digits === 0 || (at < first && isDigit(objects[at]!)) ? null : value;
  };
  let last = -1;
  for (let k = 0; k < count; k++) {
    const num = integer();
    const offset = integer();
    // Offsets go strictly forward, within the stream.
    if (num === null || offset === null || offset <= last || first + offset >= objects.length) {
      return null;
    }
    last = offset;
    out.push({ num, offset: first + offset });
  }
  while (at < first) if (!isWhitespace(objects[at++]!)) return null;
  return out;
}

/** Undoes a PNG predictor (10–15) on rows of `columns` bytes (one 8-bit colour). */
function unpredict(data: Buffer, columns: number): Buffer | null {
  const row = columns + 1;
  if (columns < 1 || data.length % row !== 0) return null;
  const rows = data.length / row;
  const out = Buffer.alloc(rows * columns);
  for (let r = 0; r < rows; r++) {
    const kind = data[r * row]!;
    for (let x = 0; x < columns; x++) {
      const raw = data[r * row + 1 + x]!;
      const left = x > 0 ? out[r * columns + x - 1]! : 0;
      const up = r > 0 ? out[(r - 1) * columns + x]! : 0;
      const upLeft = r > 0 && x > 0 ? out[(r - 1) * columns + x - 1]! : 0;
      let value: number;
      if (kind === 0) value = raw;
      else if (kind === 1) value = raw + left;
      else if (kind === 2) value = raw + up;
      else if (kind === 3) value = raw + Math.floor((left + up) / 2);
      else if (kind === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        value = raw + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
      } else return null;
      out[r * columns + x] = value & 0xff;
    }
  }
  return out;
}

/** Entries of every cross-reference section together, and of one object number, at most. */
const MAX_XREF_ENTRIES = 1_000_000;

/**
 * What the cross-reference must agree with, and what it found, checked entry by entry as
 * each is read (nothing is collected per entry, so memory does not grow with the table).
 */
interface XrefCheck {
  found: Found;
  text: string;
  /** Inflated object streams, by the offset of their `n g obj`: their `/N`. */
  objectStreamsAt: Map<number, number>;
  /** Object numbers of inflated object streams. */
  objectStreamNumbers: Set<number>;
  /** Entries left before the cap. */
  entriesLeft: number;
  /**
   * Object-stream numbers a newer section already gave an entry (the first section to name
   * a number wins), so an older entry cannot stand in for the container readers use.
   */
  decided: Set<number>;
  /** Type-1 offsets of object-stream numbers, as the newest section gives them. */
  containers: Map<number, number>;
  /** The highest index each packed entry asks of its object stream, by its number. */
  packed: Map<number, number>;
  /** Bytes of stream data the decoding may still produce or read. */
  budget: number;
  bad: boolean;
}

/** Skips up to 16 whitespace bytes: some writers point at the line break before an object. */
function skipSpace(text: string, at: number) {
  for (let k = 0; k < 16 && at < text.length && isWhitespace(text.charCodeAt(at)); k++) at++;
  return at;
}

/** A type-1 entry: in use at `offset`; it must land on an object the scan read. */
function usedEntry(check: XrefCheck, num: number, gen: number, offset: number) {
  const object = check.found.objects.get(skipSpace(check.text, offset));
  if (!object || object.num !== num || object.gen !== gen) check.bad = true;
  else if (check.objectStreamNumbers.has(num) && !check.decided.has(num)) {
    check.containers.set(num, skipSpace(check.text, offset));
  }
  decide(check, num);
}

/** Records that the newest entry for an object-stream number has been read. */
function decide(check: XrefCheck, num: number) {
  if (check.objectStreamNumbers.has(num)) check.decided.add(num);
}

/** A type-2 entry: object `num` is number `index` of the object stream numbered `stream`. */
function packedEntry(check: XrefCheck, num: number, stream: number, index: number) {
  if (index >= MAX_OBJECT_STREAM_N) {
    check.bad = true;
    return;
  }
  const highest = check.packed.get(stream);
  if (highest === undefined && check.packed.size >= MAX_OBJECT_STREAMS) check.bad = true;
  else if (highest === undefined || index > highest) check.packed.set(stream, index);
  decide(check, num);
}

/**
 * Checks the cross-reference from `startxref` back along `/XRefStm` and `/Prev` (at most
 * 64 sections, each read once); false when it is missing, unreadable, too large, or names
 * anything the scan did not read.
 */
function checkXref(check: XrefCheck): boolean {
  const { text } = check;
  const tail = text.slice(Math.max(0, text.length - 1024));
  const keyword = tail.lastIndexOf('startxref');
  if (keyword < 0) return false;
  const startxref = /^\s*(\d{1,12})\s/.exec(tail.slice(keyword + 'startxref'.length));
  if (!startxref) return false;
  // Newest first: a table's own entries, then its /XRefStm, then older sections.
  const queue = [Number(startxref[1])];
  const seen = new Set<number>();
  while (queue.length > 0) {
    const offset = queue.shift()!;
    if (seen.has(offset)) continue;
    if (seen.size >= MAX_XREF_SECTIONS || offset >= text.length) return false;
    seen.add(offset);
    const at = skipSpace(text, offset);
    if (text.startsWith('xref', at)) {
      const trailer = classicTable(check, at + 4);
      if (!trailer) return false;
      for (const p of [trailer.xrefStm, trailer.prev]) if (p !== undefined) queue.push(p);
    } else {
      const stream = check.found.streams.get(at);
      if (!stream || stream.dict.type !== 'XRef' || !xrefStream(check, stream)) return false;
      if (stream.dict.prev !== undefined) queue.push(stream.dict.prev);
    }
    if (check.bad) return false;
  }
  // Every packed object's container is, by the newest entry for its number, an object
  // stream the scan inflated and read, with room for the index.
  for (const [stream, highest] of check.packed) {
    const at = check.containers.get(stream);
    const count = at === undefined ? undefined : check.objectStreamsAt.get(at);
    if (count === undefined || highest >= count) return false;
  }
  return true;
}

/** A classic cross-reference table, entry by entry, and its trailer; null when it fails. */
function classicTable(check: XrefCheck, start: number): Dict | null {
  const { text } = check;
  let at = start;
  const token = () => {
    while (at < text.length && isWhitespace(text.charCodeAt(at))) at++;
    const from = at;
    while (at < text.length && !isWhitespace(text.charCodeAt(at)) && at - from <= 16) at++;
    return { value: text.slice(from, at), from };
  };
  const integer = (s: string) => (/^\d{1,10}$/.test(s) ? Number(s) : null);
  for (;;) {
    const head = token();
    if (head.value === 'trailer') return check.found.trailers.get(head.from) ?? null;
    const first = integer(head.value);
    const count = integer(token().value);
    // Within the cap, and an entry takes at least 18 bytes.
    if (first === null || count === null || count > check.entriesLeft) return null;
    if (count * 18 > text.length - at) return null;
    check.entriesLeft -= count;
    for (let k = 0; k < count; k++) {
      const offset = integer(token().value);
      const gen = integer(token().value);
      const kind = token().value;
      if (offset === null || gen === null || (kind !== 'n' && kind !== 'f')) return null;
      if (kind === 'n') usedEntry(check, first + k, gen, offset);
      else decide(check, first + k);
      if (check.bad) return null;
    }
  }
}

/** A cross-reference stream, entry by entry; false when it cannot be read or fails. */
function xrefStream(check: XrefCheck, stream: StreamObject): boolean {
  const { dict } = stream;
  const data = check.found.data;
  if (dict.filters.length > 1 || (dict.filters.length === 1 && dict.filters[0] !== 'FlateDecode')) {
    return false;
  }
  if (dict.decodeParmsOther || dict.size === undefined || dict.size > MAX_XREF_ENTRIES) {
    return false;
  }
  const [w0, w1, w2] = dict.w;
  if (dict.w.length !== 3 || [w0!, w1!, w2!].some((w) => w > 8)) return false;
  const width = w0! + w1! + w2!;
  if (width === 0) return false;
  const index = dict.index.length > 0 ? dict.index : [0, dict.size];
  if (index.length % 2 !== 0) return false;
  let total = 0;
  for (let k = 1; k < index.length; k += 2) total += index[k]!;
  // Checked against the cap before any row is read or decoded.
  if (total > check.entriesLeft) return false;
  check.entriesLeft -= total;
  // Raw or inflated, the data is charged to the same budget.
  let rows: Buffer | null;
  if (dict.filters.length === 0) {
    rows = data.subarray(stream.start, stream.end);
    if (rows.length > check.budget) return false;
  } else rows = inflate(data, stream, check.budget);
  if (!rows) return false;
  check.budget -= rows.length;
  const predictor = dict.parms.Predictor ?? 1;
  if (predictor >= 10 && predictor <= 15) {
    if ((dict.parms.Colors ?? 1) !== 1 || (dict.parms.BitsPerComponent ?? 8) !== 8) return false;
    rows = unpredict(rows, dict.parms.Columns ?? 1);
    if (!rows) return false;
    check.budget -= rows.length;
    if (check.budget < 0) return false;
  } else if (predictor !== 1) return false;
  if (total * width > rows.length) return false;
  const table = rows;
  const field = (at: number, bytes: number) => {
    let value = 0;
    for (let k = 0; k < bytes; k++) value = value * 256 + table[at + k]!;
    return value;
  };
  let at = 0;
  for (let k = 0; k < index.length; k += 2) {
    const first = index[k]!;
    const count = index[k + 1]!;
    for (let e = 0; e < count; e++, at += width) {
      const kind = w0 === 0 ? 1 : field(at, w0!);
      const two = field(at + w0!, w1!);
      const three = field(at + w0! + w1!, w2!);
      if (kind === 1) usedEntry(check, first + e, three, two);
      else if (kind === 2) packedEntry(check, first + e, two, three);
      else if (kind !== 0) return false;
      else decide(check, first + e);
      if (check.bad) return false;
    }
  }
  return true;
}

/** Scans a PDF's bytes; see above. */
export function scanPdf(data: Buffer): PdfScanResult {
  const found: Found = {
    data,
    active: false,
    broken: false,
    openActionDirect: false,
    openActionRefs: new Set(),
    actions: new Set(),
    objects: new Map(),
    streams: new Map(),
    objectStreams: [],
    trailers: new Map(),
  };
  const text = data.toString('latin1');
  scan(text, found);
  const encrypted =
    [...found.trailers.values()].some((d) => d.encrypt) ||
    [...found.streams.values()].some((s) => s.dict.type === 'XRef' && s.dict.encrypt);
  if (encrypted) return 'encrypted';
  if (found.broken) return 'not_a_document';

  let budget = MAX_INFLATED;
  const objectStreamsAt = new Map<number, number>();
  const objectStreamNumbers = new Set<number>();
  for (const stream of found.objectStreams) {
    const { dict } = stream;
    // Flate only, with no predictor: anything else cannot be read here, so it is refused.
    if (dict.filters.length !== 1 || dict.filters[0] !== 'FlateDecode' || dict.decodeParms) {
      return 'not_a_document';
    }
    const count = dict.n;
    const first = dict.first;
    if (
      count === undefined ||
      first === undefined ||
      count > MAX_OBJECT_STREAM_N ||
      first > MAX_OBJECT_STREAM_FIRST
    ) {
      return 'not_a_document';
    }
    const objects = inflate(data, stream, budget);
    if (!objects || first > objects.length) return 'not_a_document';
    budget -= objects.length;
    const starts = objectStreamHeader(objects, first, count);
    if (!starts) return 'not_a_document';
    const hit = scan(objects.toString('latin1'), found, starts, true);
    // Each object must start where a top-level token does.
    if (found.broken || hit.size !== starts.length) return 'not_a_document';
    objectStreamsAt.set(stream.offset, count);
    objectStreamNumbers.add(stream.num);
  }

  // Every object a reader can reach must be one read here.
  const check: XrefCheck = {
    found,
    text,
    objectStreamsAt,
    objectStreamNumbers,
    entriesLeft: MAX_XREF_ENTRIES,
    decided: new Set(),
    containers: new Map(),
    packed: new Map(),
    budget,
    bad: false,
  };
  if (!checkXref(check)) return 'not_a_document';

  if (
    found.active ||
    found.openActionDirect ||
    [...found.openActionRefs].some((ref) => found.actions.has(ref))
  ) {
    return 'active_content';
  }
  return 'ok';
}
