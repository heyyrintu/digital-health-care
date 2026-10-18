import { ApiError } from '@dhc/api-client';
import type { TestOrder } from '@dhc/contracts';
import { describe, expect, it } from 'vitest';
import { PdfCache, type PdfCacheDeps } from './pdf-cache';
import {
  clearOnSignOut,
  iosTmpUri,
  isPickerInbox,
  pickAndUpload,
  type PickedAsset,
  type UploadDeps,
} from './upload';

const ORDER: TestOrder = {
  id: '00000000-0000-4000-8000-000000000010',
  catalogueItemId: null,
  kind: 'mri',
  name: 'MRI',
  region: 'Knee',
  side: 'right',
  views: [],
  notes: null,
  status: 'result_uploaded',
  orderedAt: '2026-10-10T06:00:00.000Z',
  resultUploadedAt: '2026-10-12T05:00:00.000Z',
  reviewedAt: null,
  results: [],
};

const PDF: PickedAsset = {
  uri: 'file:///tmp/dev.dhc.patient-Inbox/report.pdf',
  name: 'report.pdf',
  mimeType: 'application/pdf',
  size: 120_000,
};

/** A picker, file reader and upload in memory, recording what was removed and closed. */
function fakeUpload(over: Partial<UploadDeps> = {}) {
  const removed: string[] = [];
  const sent: Blob[] = [];
  let closed = 0;
  const blob = { type: 'application/pdf', close: () => void closed++ } as unknown as Blob;
  const deps: UploadDeps = {
    pick: async () => PDF,
    read: async () => blob,
    send: async (file) => (sent.push(file), ORDER),
    removePicked: (uri) => void removed.push(uri),
    ...over,
  };
  return { deps, removed, sent, closed: () => closed };
}

describe('pickAndUpload', () => {
  it('uploads, then deletes the picked copy and closes the Blob', async () => {
    const f = fakeUpload();
    expect(await pickAndUpload(f.deps)).toEqual({ kind: 'uploaded', order: ORDER });
    expect(f.sent).toHaveLength(1);
    expect(f.removed).toEqual([PDF.uri]);
    expect(f.closed()).toBe(1);
  });

  it('deletes the picked copy of a file it refuses, without reading or sending it', async () => {
    const gif = { ...PDF, uri: 'file:///tmp/x-Inbox/a.gif', name: 'a.gif', mimeType: 'image/gif' };
    const reads: string[] = [];
    const f = fakeUpload({
      pick: async () => gif,
      read: async (uri) => {
        reads.push(uri);
        throw new Error('A refused file must not be read.');
      },
    });
    const outcome = await pickAndUpload(f.deps);
    expect(outcome).toEqual({ kind: 'refused', message: { key: 'patient.tests.file.type' } });
    expect(reads).toEqual([]);
    expect(f.sent).toHaveLength(0);
    expect(f.removed).toEqual([gif.uri]);

    const huge = { ...PDF, size: 26 * 1024 * 1024 };
    const g = fakeUpload({ pick: async () => huge });
    expect((await pickAndUpload(g.deps)).kind).toBe('refused');
    expect(g.removed).toEqual([huge.uri]);
  });

  it('deletes the picked copy when it cannot be read', async () => {
    const f = fakeUpload({ read: () => Promise.reject(new Error('gone')) });
    expect(await pickAndUpload(f.deps)).toEqual({ kind: 'unreadable' });
    expect(f.removed).toEqual([PDF.uri]);
    expect(f.sent).toHaveLength(0);
  });

  it('deletes the picked copy and closes the Blob when the upload fails', async () => {
    const reviewed = new ApiError(409, 'CONFLICT', 'Reviewed.', 'req-1', { status: 'reviewed' });
    const f = fakeUpload({ send: () => Promise.reject(reviewed) });
    expect(await pickAndUpload(f.deps)).toEqual({ kind: 'failed', error: reviewed });
    expect(f.removed).toEqual([PDF.uri]);
    expect(f.closed()).toBe(1);
  });

  it('has nothing to delete when the person cancels or the picker fails', async () => {
    const f = fakeUpload({ pick: async () => null });
    expect(await pickAndUpload(f.deps)).toEqual({ kind: 'cancelled' });
    expect(f.removed).toEqual([]);

    const busy = new Error('PickingInProgressException');
    const g = fakeUpload({ pick: () => Promise.reject(busy) });
    expect(await pickAndUpload(g.deps)).toEqual({ kind: 'failed', error: busy });
    expect(g.removed).toEqual([]);
    expect(g.sent).toHaveLength(0);
  });
});

describe('iOS picker copies', () => {
  it('finds tmp from the caches folder and recognises the Inbox folders', () => {
    const container = 'file:///var/mobile/Containers/Data/Application/0000-AAAA';
    expect(iosTmpUri(`${container}/Library/Caches/`)).toBe(`${container}/tmp/`);
    expect(iosTmpUri(`${container}/Library/Caches`)).toBe(`${container}/tmp/`);
    expect(iosTmpUri('file:///data/user/0/dev.dhc.patient/cache/')).toBeNull();
    expect(isPickerInbox('dev.dhc.patient-Inbox')).toBe(true);
    expect(isPickerInbox('-Inbox')).toBe(false);
    expect(isPickerInbox('Inbox')).toBe(false);
    expect(isPickerInbox('other')).toBe(false);
  });
});

describe('clearOnSignOut', () => {
  /** A cache folder in memory holding one result opened on Android (kept after sharing). */
  async function cacheWithFile() {
    const files = new Map<string, Uint8Array>();
    const deps: PdfCacheDeps = {
      write(name, bytes) {
        files.set(name, bytes);
        return { uri: `cache/${name}`, remove: () => void files.delete(name) };
      },
      clearAll: () => files.clear(),
      canShare: async () => true,
      share: async () => undefined,
      keepAfterShare: true,
    };
    const cache = new PdfCache(deps);
    await cache.open('test-result-1.pdf', async () => new Uint8Array([37]), 'MRI knee, right');
    return { cache, files };
  }

  it('on sign-out forgets the family and deletes results, PDFs and picked files', async () => {
    const results = await cacheWithFile();
    const pdfs = await cacheWithFile();
    const picked = new Set([PDF.uri]);
    let resets = 0;
    const parts = {
      account: { reset: () => void resets++ },
      caches: [pdfs.cache, results.cache],
      clearPicked: () => picked.clear(),
    };
    expect(results.files.size).toBe(1);

    expect(clearOnSignOut('signed_in', parts)).toBe(false);
    expect(results.files.size).toBe(1);

    expect(clearOnSignOut('signed_out', parts)).toBe(true);
    expect(resets).toBe(1);
    expect(results.files.size).toBe(0);
    expect(pdfs.files.size).toBe(0);
    expect(picked.size).toBe(0);
  });

  it('still deletes the files when an earlier step throws', async () => {
    const results = await cacheWithFile();
    const picked = new Set([PDF.uri]);
    clearOnSignOut('expired', {
      account: {
        reset: () => {
          throw new Error('boom');
        },
      },
      caches: [results.cache],
      clearPicked: () => picked.clear(),
    });
    expect(results.files.size).toBe(0);
    expect(picked.size).toBe(0);
  });
});
