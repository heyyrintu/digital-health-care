/** A file written to the app's cache, ready to hand to the OS share sheet. */
export interface WrittenPdf {
  uri: string;
  /** Deletes this file; never throws. */
  remove(): void;
}

export interface PdfCacheDeps {
  /** Writes the bytes as `name` in the cache folder. */
  write(name: string, bytes: Uint8Array): WrittenPdf;
  /** Deletes the whole cache folder; never throws. */
  clearAll(): void;
  /** False where the OS has no share sheet to hand a file to. */
  canShare(): Promise<boolean>;
  /**
   * Opens the share sheet for a file of this media type; resolves when it closes (Android:
   * when the chooser hands off).
   */
  share(uri: string, title: string, mediaType: string): Promise<void>;
  /**
   * Android resolves the share as soon as the chooser hands the file to an app, which may read
   * it later, so the copy is kept until the next open or sign-out instead of deleted at once.
   */
  keepAfterShare: boolean;
}

export type OpenResult = 'shared' | 'busy' | 'cannot-share' | 'signed-out';

/**
 * Files the patient views or shares: signed prescription PDFs, and test results (a PDF or a
 * photo), each kind in its own cache folder. A patient's phone may be lost or shared (threat
 * model T24), so at most one copy per folder exists: it lives only in the app's private
 * cache, is deleted when the sheet closes (iOS) or when the next file is opened (Android),
 * and signing out empties the folder.
 */
export class PdfCache {
  /** Bumped by clear(), so a download that finishes after sign-out is never written. */
  private generation = 0;
  /** Set synchronously, so a second tap in the same frame cannot start another share. */
  private busy = false;

  constructor(private readonly deps: PdfCacheDeps) {}

  async open(
    name: string,
    download: () => Promise<Uint8Array>,
    title: string,
    mediaType = 'application/pdf',
  ): Promise<OpenResult> {
    if (this.busy) return 'busy';
    this.busy = true;
    try {
      if (!(await this.deps.canShare())) return 'cannot-share';
      const started = this.generation;
      const bytes = await download();
      if (started !== this.generation) return 'signed-out';
      // Only the newest copy is ever on disk: the one Android kept from the last open goes now.
      this.deps.clearAll();
      const file = this.deps.write(name, bytes);
      let shared = false;
      try {
        await this.deps.share(file.uri, title, mediaType);
        shared = true;
      } finally {
        if (!shared || !this.deps.keepAfterShare) file.remove();
      }
      return 'shared';
    } finally {
      this.busy = false;
    }
  }

  /** Signed out (or the app started without a session): delete every file this cache wrote. */
  clear(): void {
    this.generation += 1;
    this.deps.clearAll();
  }
}
