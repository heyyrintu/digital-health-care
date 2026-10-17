import { describe, expect, it } from 'vitest';
import { PdfCache, type PdfCacheDeps } from './pdf-cache';

/** An in-memory cache folder and share sheet; `share` waits until the test releases it. */
function fakeDeps(over: Partial<PdfCacheDeps> = {}) {
  const files = new Map<string, Uint8Array>();
  const shared: string[] = [];
  let release: (() => void) | null = null;
  const deps: PdfCacheDeps = {
    write(name, bytes) {
      files.set(name, bytes);
      return { uri: `cache/${name}`, remove: () => void files.delete(name) };
    },
    clearAll: () => files.clear(),
    canShare: async () => true,
    share: (uri) => {
      shared.push(uri);
      return new Promise<void>((resolve) => (release = resolve));
    },
    keepAfterShare: false,
    ...over,
  };
  const closeSheet = async () => {
    await new Promise((r) => setTimeout(r, 0));
    release?.();
  };
  return { deps, files, shared, closeSheet };
}

const bytes = () => Promise.resolve(new Uint8Array([37, 80, 68, 70]));

describe('PdfCache', () => {
  it('shares the PDF and deletes the copy when the sheet closes', async () => {
    const f = fakeDeps();
    const cache = new PdfCache(f.deps);
    const opening = cache.open('SG-00042-v1.pdf', bytes, 'Prescription SG-00042');
    await f.closeSheet();
    expect(await opening).toBe('shared');
    expect(f.shared).toEqual(['cache/SG-00042-v1.pdf']);
    expect(f.files.size).toBe(0);
  });

  it('on Android keeps the copy for the chosen app until the next open or sign-out', async () => {
    const f = fakeDeps({ keepAfterShare: true });
    const cache = new PdfCache(f.deps);
    const first = cache.open('A-v1.pdf', bytes, 'A');
    await f.closeSheet();
    await first;
    expect([...f.files.keys()]).toEqual(['A-v1.pdf']);

    const second = cache.open('B-v1.pdf', bytes, 'B');
    await f.closeSheet();
    await second;
    expect([...f.files.keys()]).toEqual(['B-v1.pdf']);

    cache.clear();
    expect(f.files.size).toBe(0);
  });

  it('ignores a second open while one is in progress', async () => {
    const f = fakeDeps();
    const cache = new PdfCache(f.deps);
    const first = cache.open('A-v1.pdf', bytes, 'A');
    expect(await cache.open('A-v1.pdf', bytes, 'A')).toBe('busy');
    await f.closeSheet();
    expect(await first).toBe('shared');
    expect(f.shared).toHaveLength(1);
  });

  it('drops a download that finishes after sign-out', async () => {
    const f = fakeDeps();
    const cache = new PdfCache(f.deps);
    let finish!: (b: Uint8Array) => void;
    const opening = cache.open(
      'A-v1.pdf',
      () => new Promise<Uint8Array>((resolve) => (finish = resolve)),
      'A',
    );
    await new Promise((r) => setTimeout(r, 0));
    cache.clear();
    finish(new Uint8Array([1]));
    expect(await opening).toBe('signed-out');
    expect(f.files.size).toBe(0);
    expect(f.shared).toHaveLength(0);
  });

  it('deletes the copy when sharing fails, even on Android', async () => {
    const f = fakeDeps({ keepAfterShare: true, share: () => Promise.reject(new Error('no')) });
    const cache = new PdfCache(f.deps);
    await expect(cache.open('A-v1.pdf', bytes, 'A')).rejects.toThrow('no');
    expect(f.files.size).toBe(0);
    // The failed open does not leave the cache busy.
    f.deps.share = () => Promise.resolve();
    expect(await cache.open('A-v1.pdf', bytes, 'A')).toBe('shared');
  });

  it('shares a PDF by default and a photo with its own media type', async () => {
    const types: string[] = [];
    const f = fakeDeps({ share: async (_uri, _title, type) => void types.push(type) });
    const cache = new PdfCache(f.deps);
    await cache.open('A-v1.pdf', bytes, 'A');
    await cache.open('result-1.jpg', bytes, 'MRI knee, right', 'image/jpeg');
    expect(types).toEqual(['application/pdf', 'image/jpeg']);
  });

  it('reports a phone that cannot share without downloading', async () => {
    let downloads = 0;
    const f = fakeDeps({ canShare: async () => false });
    const cache = new PdfCache(f.deps);
    const result = await cache.open('A-v1.pdf', () => (downloads++, bytes()), 'A');
    expect(result).toBe('cannot-share');
    expect(downloads).toBe(0);
  });
});
