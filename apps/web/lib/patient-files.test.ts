import { describe, expect, it } from 'vitest';
import {
  canShowInBrowser,
  OpenFiles,
  openFile,
  SAVE_URL_TTL_MS,
  saveFile,
  SHOWN_URL_MAX_MS,
  TAB_POLL_MS,
  type FileDeps,
} from './patient-files';

/** A browser in memory, recording what the page did with tabs, URLs and downloads. */
function fakeBrowser({ tab = 'open' }: { tab?: 'open' | 'blocked' | 'closed' } = {}) {
  const log: string[] = [];
  const blobs = new Map<string, Blob>();
  let timers: { run: () => void; ms: number; repeat: boolean }[] = [];
  let n = 0;
  let tabClosed = tab === 'closed';
  const handle = {
    show: (url: string) => void log.push(`show ${url}`),
    close: () => {
      tabClosed = true;
      log.push('close');
    },
    get closed() {
      return tabClosed;
    },
  };
  const deps: FileDeps = {
    openTab() {
      log.push('tab');
      return tab === 'blocked' ? null : handle;
    },
    createUrl: (blob) => {
      const url = `blob:portal/${++n}`;
      blobs.set(url, blob);
      return url;
    },
    revokeUrl: (url) => void log.push(`revoke ${url}`),
    save: (url, name) => void log.push(`save ${url} as ${name}`),
    later: (run, ms) => {
      const t = { run, ms, repeat: false };
      timers.push(t);
      return () => {
        timers = timers.filter((x) => x !== t);
      };
    },
    every: (run, ms) => {
      const t = { run, ms, repeat: true };
      timers.push(t);
      return () => {
        timers = timers.filter((x) => x !== t);
      };
    },
  };
  /** Fires the timers of this length once (a repeating one stays). */
  const tick = (ms: number) => {
    for (const t of timers.filter((x) => x.ms === ms)) {
      if (!t.repeat) timers = timers.filter((x) => x !== t);
      t.run();
    }
  };
  return {
    files: new OpenFiles(deps),
    log,
    blobs,
    tick,
    timers: () => timers,
    userClosesTab: () => void (tabClosed = true),
  };
}

const pdf = new Blob(['%PDF-1.7'], { type: 'application/pdf' });
const PDF = { name: 'SG-00042-v2.pdf', mediaType: 'application/pdf' };

describe('openFile', () => {
  it('opens the tab before the download and shows the file there, re-typed as expected', async () => {
    const b = fakeBrowser();
    const fetched: string[] = [];
    const outcome = await openFile(
      async () => {
        // The tab is already open: the browser saw it come from the click.
        fetched.push(b.log.join(','));
        return new Blob(['%PDF-1.7'], { type: 'application/pdf; charset=binary' });
      },
      PDF,
      b.files,
    );
    expect(outcome).toEqual({ kind: 'shown' });
    expect(fetched).toEqual(['tab']);
    expect(b.log).toEqual(['tab', 'show blob:portal/1']);
    expect(b.blobs.get('blob:portal/1')!.type).toBe('application/pdf');
  });

  it('keeps a shown file while its tab is open, and revokes it once the tab closes', async () => {
    const b = fakeBrowser();
    await openFile(async () => pdf, PDF, b.files);
    b.tick(TAB_POLL_MS);
    expect(b.log).not.toContain('revoke blob:portal/1');
    b.userClosesTab();
    b.tick(TAB_POLL_MS);
    expect(b.log).toContain('revoke blob:portal/1');
    expect(b.files.size).toBe(0);
    expect(b.timers()).toHaveLength(0);
  });

  it('revokes a shown file after 30 minutes even if its tab stays open', async () => {
    const b = fakeBrowser();
    await openFile(async () => pdf, PDF, b.files);
    b.tick(SHOWN_URL_MAX_MS);
    expect(b.log).toContain('revoke blob:portal/1');
    expect(b.timers()).toHaveLength(0);
  });

  it('never renders a file the server sent as another type: it is saved instead', async () => {
    const b = fakeBrowser();
    const outcome = await openFile(
      async () => new Blob(['<script>alert(1)</script>'], { type: 'text/html' }),
      PDF,
      b.files,
    );
    expect(outcome).toEqual({ kind: 'saved' });
    expect(b.log).toEqual(['tab', 'close', 'save blob:portal/1 as SG-00042-v2.pdf']);
    expect(b.blobs.get('blob:portal/1')!.type).toBe('application/octet-stream');
  });

  it('closes the tab again when the download fails, and lets the page say why', async () => {
    const b = fakeBrowser();
    const refused = new Error('consent withdrawn');
    await expect(openFile(() => Promise.reject(refused), PDF, b.files)).rejects.toBe(refused);
    expect(b.log).toEqual(['tab', 'close']);
    expect(b.files.size).toBe(0);
  });

  it('saves nothing unasked when the browser blocked the tab: the URL is kept for a link', async () => {
    const b = fakeBrowser({ tab: 'blocked' });
    const outcome = await openFile(async () => pdf, PDF, b.files);
    expect(outcome).toEqual({ kind: 'blocked', url: 'blob:portal/1', name: 'SG-00042-v2.pdf' });
    expect(b.log).toEqual(['tab']);
    expect(b.files.size).toBe(1);
    b.tick(SHOWN_URL_MAX_MS);
    expect(b.log).toContain('revoke blob:portal/1');
  });

  it('treats a tab that came back already closed as blocked', async () => {
    const b = fakeBrowser({ tab: 'closed' });
    const outcome = await openFile(async () => pdf, PDF, b.files);
    expect(outcome.kind).toBe('blocked');
    expect(b.log).toEqual(['tab']);
  });

  it('saves a photo type browsers cannot show, without opening a tab', async () => {
    const b = fakeBrowser();
    const outcome = await openFile(
      async () => new Blob(['x'], { type: 'image/heic' }),
      { name: 'test-result-2.heic', mediaType: 'image/heic' },
      b.files,
    );
    expect(outcome).toEqual({ kind: 'saved' });
    expect(b.log).toEqual(['save blob:portal/1 as test-result-2.heic']);
  });
});

describe('saveFile', () => {
  it('saves under the given name and revokes the URL later', async () => {
    const b = fakeBrowser();
    await saveFile(async () => pdf, 'SG-00042-v2.pdf', b.files);
    expect(b.log).toEqual(['save blob:portal/1 as SG-00042-v2.pdf']);
    b.tick(SAVE_URL_TTL_MS);
    expect(b.log).toContain('revoke blob:portal/1');
  });

  it('creates nothing when the download fails', async () => {
    const b = fakeBrowser();
    await expect(
      saveFile(() => Promise.reject(new Error('x')), 'a.pdf', b.files),
    ).rejects.toThrow();
    expect(b.log).toEqual([]);
    expect(b.files.size).toBe(0);
  });
});

describe('OpenFiles on sign-out', () => {
  it('closes every tab the portal opened and revokes every URL', async () => {
    const b = fakeBrowser();
    await openFile(async () => pdf, PDF, b.files);
    await saveFile(async () => pdf, 'a.pdf', b.files);
    b.files.closeAll();
    expect(b.log).toContain('close');
    expect(b.log).toContain('revoke blob:portal/1');
    expect(b.log).toContain('revoke blob:portal/2');
    expect(b.files.size).toBe(0);
    expect(b.timers()).toHaveLength(0);
    // Releasing again (a timer that fired late, a link clicked after) does nothing.
    b.files.release('blob:portal/1');
    expect(b.log.filter((l) => l === 'revoke blob:portal/1')).toHaveLength(1);
  });

  it('closes a tab whose download is still running, and then shows nothing in it', async () => {
    const b = fakeBrowser();
    let arrive: (blob: Blob) => void = () => undefined;
    const pending = openFile(() => new Promise<Blob>((r) => (arrive = r)), PDF, b.files);
    b.files.closeAll();
    expect(b.log).toEqual(['tab', 'close']);
    arrive(pdf);
    expect(await pending).toEqual({ kind: 'ended' });
    expect(b.log).toEqual(['tab', 'close', 'close']);
    expect(b.files.size).toBe(0);
  });

  it('saves nothing when the session ends during a download', async () => {
    const b = fakeBrowser();
    let arrive: (blob: Blob) => void = () => undefined;
    const pending = saveFile(() => new Promise<Blob>((r) => (arrive = r)), 'a.pdf', b.files);
    b.files.closeAll();
    arrive(pdf);
    await pending;
    expect(b.log).toEqual([]);
    expect(b.files.size).toBe(0);
  });
});

describe('canShowInBrowser', () => {
  it('shows PDFs, JPEG and PNG; saves HEIC, HEIF and anything else', () => {
    for (const type of ['application/pdf', 'image/jpeg', 'image/png', 'IMAGE/PNG']) {
      expect(canShowInBrowser(type), type).toBe(true);
    }
    for (const type of ['image/heic', 'image/heif', 'text/html', 'application/octet-stream']) {
      expect(canShowInBrowser(type), type).toBe(false);
    }
  });
});
