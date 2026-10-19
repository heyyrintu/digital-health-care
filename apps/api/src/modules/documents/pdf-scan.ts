/**
 * A check of a PDF the API wrote itself (threat model T27): the output of the rebuild in
 * `pdf-rebuild-worker.ts`, never an upload. It asserts that the rebuild did what it says, in
 * the shape pdf-lib writes with object streams off:
 *
 * - the file is the `%PDF-1.x` header, then indirect objects one after another, then one
 *   classic cross-reference table, a trailer, `startxref` and `%%EOF`;
 * - every object is a value in plain PDF syntax (no comments, no unknown keywords, nesting at
 *   most `MAX_DEPTH` deep), optionally followed by stream data of exactly its direct
 *   `/Length`;
 * - the table lists exactly the objects in the file, at the offsets where they start, and
 *   `startxref` points at it; the trailer has `/Root` and `/Size` and no `/Encrypt`,
 *   `/Prev` or `/XRefStm`;
 * - no object stream or cross-reference stream (`/ObjStm`, `/XRef`), none of the names in
 *   `BLOCKED` (actions, URIs, XMP metadata) anywhere outside stream data, with `#xx`
 *   escapes decoded, and no stream dictionary pointing at another file (`/F`, `/FFilter`,
 *   `/FDecodeParms`, `/Ref`);
 * - no stream's data holds an `n g obj` header (an object a lenient reader could find in
 *   it; the rebuild compresses streams that had no filter, and compressed data matches by
 *   chance about once in 10^14 bytes).
 *
 * Returns null when the file passes, else a short reason (for logs and tests). One pass,
 * each byte read a bounded number of times.
 */

/** Names the output may not hold (kept in step with `BLOCKED` in the rebuild). */
const BLOCKED = new Set([
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
  'ObjStm',
  'XRef',
]);

/** Keys a stream dictionary may not have: data in another file, or another file's page. */
const STREAM_KEYS_REFUSED = ['F', 'FFilter', 'FDecodeParms', 'Ref'];

/** Deepest nesting of arrays and dictionaries accepted. */
export const MAX_DEPTH = 100;

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
const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)$/;
const INTEGER = /^\d+$/;
/** Longest token other than a name: pdf-lib writes short numbers and keywords. */
const MAX_TOKEN = 64;

class Problem extends Error {}
const fail = (reason: string): never => {
  throw new Problem(reason);
};

/** A value as far as the check needs it: names and numbers, and a dictionary's keys. */
type Value =
  | { kind: 'name'; name: string }
  | { kind: 'number'; text: string }
  | { kind: 'dict'; entries: Map<string, Value> }
  | { kind: 'other' };
const OTHER: Value = { kind: 'other' };

class Reader {
  at = 0;
  readonly data: Uint8Array;
  readonly text: string;
  constructor(data: Uint8Array, text: string) {
    this.data = data;
    this.text = text;
  }

  skipWhitespace() {
    while (this.at < this.data.length && isWhitespace(this.data[this.at]!)) this.at++;
  }

  /** The next token (whitespace skipped), without consuming it. */
  peek(): string {
    const start = this.at;
    const token = this.token();
    this.at = start;
    return token;
  }

  /** Reads a token: a delimiter (`<<` and `>>` as one), or a run of regular characters. */
  token(): string {
    this.skipWhitespace();
    if (this.at >= this.data.length) return '';
    const c = this.data[this.at]!;
    if (c === 0x3c && this.data[this.at + 1] === 0x3c) return this.take(2);
    if (c === 0x3e && this.data[this.at + 1] === 0x3e) return this.take(2);
    if (c === 0x2f) {
      let end = this.at + 1;
      while (
        end < this.data.length &&
        !isWhitespace(this.data[end]!) &&
        !isDelimiter(this.data[end]!)
      )
        end++;
      return this.take(end - this.at);
    }
    if (isDelimiter(c)) return this.take(1);
    let end = this.at;
    while (
      end < this.data.length &&
      !isWhitespace(this.data[end]!) &&
      !isDelimiter(this.data[end]!)
    )
      end++;
    return this.take(end - this.at);
  }

  take(length: number) {
    const token = this.text.slice(this.at, this.at + length);
    this.at += length;
    return token;
  }

  /** Skips a literal string whose `(` was read: nested parentheses, backslash escapes. */
  skipLiteralString() {
    let depth = 1;
    while (this.at < this.data.length) {
      const c = this.data[this.at++]!;
      if (c === 0x5c) this.at++;
      else if (c === 0x28) depth++;
      else if (c === 0x29 && --depth === 0) return;
    }
    fail('unterminated string');
  }

  /** Skips a hex string whose `<` was read. */
  skipHexString() {
    while (this.at < this.data.length) {
      const c = this.data[this.at++]!;
      if (c === 0x3e) return;
      if (!isWhitespace(c) && !/[0-9a-fA-F]/.test(String.fromCharCode(c))) fail('bad hex string');
    }
    fail('unterminated hex string');
  }

  /** Reads one value; a reference `n g R` counts as one. */
  value(depth: number): Value {
    if (depth > MAX_DEPTH) fail('nested too deep');
    const token = this.token();
    if (token === '') fail('unexpected end');
    if (token.startsWith('/')) {
      const name = decodeName(token.slice(1));
      if (BLOCKED.has(name)) fail(`blocked name /${name}`);
      return { kind: 'name', name };
    }
    if (token === '(') {
      this.skipLiteralString();
      return OTHER;
    }
    if (token === '<') {
      this.skipHexString();
      return OTHER;
    }
    if (token === '[') {
      while (this.peek() !== ']') this.value(depth + 1);
      this.token();
      return OTHER;
    }
    if (token === '<<') {
      const entries = new Map<string, Value>();
      for (;;) {
        const key = this.token();
        if (key === '>>') return { kind: 'dict', entries };
        if (!key.startsWith('/')) fail(`dictionary key ${key.slice(0, 20)}`);
        const name = decodeName(key.slice(1));
        if (BLOCKED.has(name)) fail(`blocked name /${name}`);
        entries.set(name, this.value(depth + 1));
      }
    }
    if (token === 'true' || token === 'false' || token === 'null') return OTHER;
    if (token.length > MAX_TOKEN) fail('long token');
    if (NUMBER.test(token)) {
      // A reference: two integers and `R`.
      if (INTEGER.test(token)) {
        const back = this.at;
        const generation = this.token();
        if (INTEGER.test(generation) && this.token() === 'R') return OTHER;
        this.at = back;
      }
      return { kind: 'number', text: token };
    }
    return fail(`unexpected token ${token.slice(0, 20)}`);
  }

  keyword(expected: string) {
    if (this.token() !== expected) fail(`expected ${expected}`);
  }

  /** An end of line: CR LF or LF. */
  endOfLine() {
    if (this.data[this.at] === 0x0d) this.at++;
    if (this.data[this.at] !== 0x0a) fail('expected end of line');
    this.at++;
  }
}

const isDigit = (c: number) => c >= 0x30 && c <= 0x39;

/**
 * Whether `text[start, end)` holds an `n g obj` header. Each `obj` is checked backwards
 * (white space, digits, white space, digits), so the time is linear in the length.
 */
function hidesObject(text: string, start: number, end: number): boolean {
  for (
    let at = text.indexOf('obj', start);
    at >= 0 && at + 3 <= end;
    at = text.indexOf('obj', at + 3)
  ) {
    const after = text.charCodeAt(at + 3);
    if (at + 3 < end && !isWhitespace(after) && !isDelimiter(after)) continue;
    let i = at - 1;
    const run = (test: (c: number) => boolean) => {
      const from = i;
      while (i >= start && test(text.charCodeAt(i))) i--;
      return i < from;
    };
    if (run(isWhitespace) && run(isDigit) && run(isWhitespace) && run(isDigit)) return true;
  }
  return false;
}

const decodeName = (raw: string) =>
  raw.replace(/#([0-9a-fA-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));

function check(data: Uint8Array) {
  const text = Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('latin1');
  const header = /^%PDF-1\.\d\n%[\x80-\xff]{4}\n/.exec(text);
  if (!header) fail('header');
  const read = new Reader(data, text);
  read.at = header![0].length;

  /** Object number → offset of its header. */
  const objects = new Map<number, number>();
  let largest = 0;
  for (;;) {
    read.skipWhitespace();
    const start = read.at;
    const first = read.token();
    if (first === 'xref') break;
    const generation = read.token();
    if (!INTEGER.test(first) || !INTEGER.test(generation) || read.token() !== 'obj') {
      fail(`object header at ${start}`);
    }
    const number = Number(first);
    if (objects.has(number)) fail(`object ${number} twice`);
    objects.set(number, start);
    largest = Math.max(largest, number);
    const value = read.value(0);
    const next = read.token();
    if (next === 'stream') {
      if (value.kind !== 'dict') fail(`stream ${number} without dictionary`);
      const dict = value.kind === 'dict' ? value.entries : new Map<string, Value>();
      for (const key of STREAM_KEYS_REFUSED) {
        if (dict.has(key)) fail(`stream ${number} has /${key}`);
      }
      const length = dict.get('Length');
      if (length?.kind !== 'number' || !INTEGER.test(length.text)) fail(`stream ${number} length`);
      read.endOfLine();
      const end = read.at + Number(length!.kind === 'number' ? length!.text : 0);
      if (end > data.length) fail(`stream ${number} past the end`);
      if (hidesObject(text, read.at, end)) {
        fail(`object header in stream ${number}`);
      }
      read.at = end;
      read.keyword('endstream');
      read.keyword('endobj');
    } else if (next !== 'endobj') {
      fail(`object ${number} not ended`);
    }
  }

  // One classic table: subsections of fixed-width entries.
  const xrefAt = read.at - 4;
  const listed = new Set<number>();
  for (;;) {
    const first = read.token();
    if (first === 'trailer') break;
    const count = read.token();
    if (!INTEGER.test(first) || !INTEGER.test(count)) fail('cross-reference subsection');
    read.endOfLine();
    for (let i = 0; i < Number(count); i++) {
      const entry = /^(\d{10}) (\d{5}) ([fn])(?: \n|\r\n| \r)/.exec(
        text.slice(read.at, read.at + 20),
      );
      if (!entry) fail('cross-reference entry');
      read.at += 20;
      const number = Number(first) + i;
      if (entry![3] === 'f') continue;
      if (objects.get(number) !== Number(entry![1])) fail(`object ${number} offset`);
      listed.add(number);
    }
  }
  if (listed.size !== objects.size) fail('objects not in the cross-reference');
  const trailer = read.value(0);
  if (trailer.kind !== 'dict') fail('trailer');
  const entries = trailer.kind === 'dict' ? trailer.entries : new Map<string, Value>();
  if (!entries.has('Root')) fail('trailer without Root');
  const size = entries.get('Size');
  if (size?.kind !== 'number' || Number(size.text) <= largest) {
    fail('trailer size');
  }
  for (const key of ['Encrypt', 'Prev', 'XRefStm']) {
    if (entries.has(key)) fail(`trailer ${key}`);
  }
  read.keyword('startxref');
  if (Number(read.token()) !== xrefAt) fail('startxref');
  read.skipWhitespace();
  if (!/^%%EOF\s*$/.test(text.slice(read.at))) fail('end of file');
}

/** Checks a PDF the rebuild wrote (above): null if it passes, else why not. */
export function checkOwnPdf(data: Uint8Array): string | null {
  try {
    check(data);
    return null;
  } catch (error) {
    if (error instanceof Problem) return error.message;
    return `check: ${String(error)}`;
  }
}
