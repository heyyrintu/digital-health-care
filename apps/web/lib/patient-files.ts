/**
 * Opening the patient's files on the web portal: a prescription PDF, an uploaded test
 * result and a document the clinic shared (threat model T12, T24, T27). The file is fetched by the API client with the bearer
 * token in the header (never in a URL) and shown from an object URL in a new tab, only when
 * it is the type the page expects and a type the browser shows safely; anything else is
 * saved under a name that says nothing about the test. Every tab and object URL is kept in
 * a registry, so they are closed and revoked when the session ends. The browser parts are
 * passed in, so the decisions are unit tested.
 */

/** What a page needs from the browser to show or save a file. */
export interface FileDeps {
  /** A new, empty tab, opened before the download so the browser does not block it. */
  openTab(): FileTab | null;
  createUrl(blob: Blob): string;
  revokeUrl(url: string): void;
  /** Saves the URL's file under `name` (a link with `download`). */
  save(url: string, name: string): void;
  /** Runs `run` after `ms`; returns a cancel. */
  later(run: () => void, ms: number): () => void;
  /** Runs `run` every `ms`; returns a cancel. */
  every(run: () => void, ms: number): () => void;
}

export interface FileTab {
  show(url: string): void;
  close(): void;
  /** True once the person (or the browser, blocking it) closed the tab. */
  readonly closed: boolean;
}

/** A saved file's URL lives long enough for the download to start. */
export const SAVE_URL_TTL_MS = 60_000;
/** A shown file's URL lives while its tab is open (so the viewer can save and reload it), at most this long. */
export const SHOWN_URL_MAX_MS = 30 * 60_000;
/** How often an open tab is checked for having been closed. */
export const TAB_POLL_MS = 5_000;
/** A blocked tab's fallback link, once clicked, keeps its URL this long for the download to start. */
export const CLICKED_URL_TTL_MS = 1_000;

/** Types every current browser shows in a tab; HEIC and HEIF photos are saved instead. */
const SHOWN = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);

/** A media type without parameters, lowercased: `application/pdf; charset=x` → `application/pdf`. */
const bare = (type: string) => type.split(';')[0]!.trim().toLowerCase();

export const canShowInBrowser = (mediaType: string) => SHOWN.has(bare(mediaType));

/**
 * The tabs and object URLs the portal opened in this browser tab. Each URL is revoked when
 * its time is up, its tab is closed, or the session ends (`closeAll`), whichever is first.
 */
export class OpenFiles {
  private readonly tabs = new Set<FileTab>();
  /** Each URL with the cancels of its timers. */
  private readonly urls = new Map<string, (() => void)[]>();
  private ended = 0;

  constructor(readonly deps: FileDeps) {}

  /** Changes each time the session ends: a download that started before is then dropped. */
  get session(): number {
    return this.ended;
  }

  /** Keeps a tab from the moment it opens, so a sign-out during the download closes it too. */
  adopt(tab: FileTab): void {
    this.tabs.add(tab);
  }

  /** Forgets a tab the portal closed itself. */
  forget(tab: FileTab | null): void {
    if (tab) this.tabs.delete(tab);
  }

  /** Keeps a URL until `ttlMs`, and while `tab` stays open when one is given. */
  track(url: string, ttlMs: number, tab?: FileTab): void {
    // Time is up: the URL goes, but a tab still open stays known, so sign-out still closes it.
    const cancels = [this.deps.later(() => this.release(url), ttlMs)];
    if (tab) {
      this.tabs.add(tab);
      cancels.push(
        this.deps.every(() => {
          if (tab.closed) this.release(url, tab);
        }, TAB_POLL_MS),
      );
    }
    this.urls.set(url, cancels);
  }

  /** Revokes a URL (and forgets its tab) now; a URL already released is left alone. */
  release(url: string, tab?: FileTab): void {
    if (tab) this.tabs.delete(tab);
    const cancels = this.urls.get(url);
    if (!cancels) return;
    this.urls.delete(url);
    for (const cancel of cancels) cancel();
    this.deps.revokeUrl(url);
  }

  /** The session ended: every tab the portal opened is closed and every URL revoked. */
  closeAll(): void {
    this.ended += 1;
    for (const tab of this.tabs) {
      try {
        tab.close();
      } catch {
        // Already gone.
      }
    }
    this.tabs.clear();
    for (const url of [...this.urls.keys()]) this.release(url);
  }

  /** How many URLs are still live (for tests). */
  get size(): number {
    return this.urls.size;
  }
}

export type OpenOutcome =
  | { kind: 'shown' }
  | { kind: 'saved' }
  /** The session ended during the download: nothing was shown or saved. */
  | { kind: 'ended' }
  /** The browser blocked the tab: the page offers `url` as a download link the person clicks. */
  | { kind: 'blocked'; url: string; name: string };

/**
 * Shows a file in a new tab. The tab opens first, synchronously from the click, and closes
 * again if the download fails (the error is rethrown for the page to show). The file is
 * shown only when the server sent the type expected and the browser shows it safely, and
 * then re-typed as exactly that type; otherwise it is saved, never rendered. When the
 * browser blocked the tab, nothing is saved unasked: the URL is kept for a link.
 */
export async function openFile(
  fetchFile: () => Promise<Blob>,
  { name, mediaType }: { name: string; mediaType: string },
  files: OpenFiles,
): Promise<OpenOutcome> {
  const { deps } = files;
  const session = files.session;
  const wanted = bare(mediaType);
  const tab = canShowInBrowser(wanted) ? deps.openTab() : null;
  if (tab) files.adopt(tab);
  const drop = () => {
    tab?.close();
    files.forget(tab);
  };
  let blob: Blob;
  try {
    blob = await fetchFile();
  } catch (e) {
    drop();
    throw e;
  }
  // Signed out meanwhile: the file is neither shown nor saved.
  if (files.session !== session) {
    drop();
    return { kind: 'ended' };
  }
  if (!canShowInBrowser(wanted) || bare(blob.type) !== wanted) {
    drop();
    saveBlob(new Blob([blob], { type: 'application/octet-stream' }), name, files);
    return { kind: 'saved' };
  }
  const url = deps.createUrl(new Blob([blob], { type: wanted }));
  if (!tab || tab.closed) {
    files.forget(tab);
    files.track(url, SHOWN_URL_MAX_MS);
    return { kind: 'blocked', url, name };
  }
  files.track(url, SHOWN_URL_MAX_MS, tab);
  tab.show(url);
  return { kind: 'shown' };
}

/** Saves a file under `name` without opening a tab (a person's own Download). */
export async function saveFile(
  fetchFile: () => Promise<Blob>,
  name: string,
  files: OpenFiles,
): Promise<void> {
  const session = files.session;
  const blob = await fetchFile();
  // Signed out meanwhile: nothing is saved.
  if (files.session === session) saveBlob(blob, name, files);
}

function saveBlob(blob: Blob, name: string, files: OpenFiles) {
  const url = files.deps.createUrl(blob);
  files.track(url, SAVE_URL_TTL_MS);
  files.deps.save(url, name);
}

/** The real browser. */
export function browserFileDeps(): FileDeps {
  return {
    openTab() {
      const tab = window.open('', '_blank');
      // A blocker may hand back a tab that is already closed.
      if (!tab || tab.closed) return null;
      // The new tab gets no handle back on the portal.
      tab.opener = null;
      return {
        show: (url) => {
          tab.location.href = url;
        },
        close: () => tab.close(),
        get closed() {
          return tab.closed;
        },
      };
    },
    createUrl: (blob) => URL.createObjectURL(blob),
    revokeUrl: (url) => URL.revokeObjectURL(url),
    save(url, name) {
      const link = document.createElement('a');
      link.href = url;
      link.download = name;
      link.rel = 'noopener';
      document.body.append(link);
      link.click();
      link.remove();
    },
    later: (run, ms) => {
      const id = setTimeout(run, ms);
      return () => clearTimeout(id);
    },
    every: (run, ms) => {
      const id = setInterval(run, ms);
      return () => clearInterval(id);
    },
  };
}
