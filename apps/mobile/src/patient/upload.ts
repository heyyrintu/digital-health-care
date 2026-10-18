import { checkPickedFile, fileCheckMessage, type Message } from '@dhc/api-client';
import type { TestOrder } from '@dhc/contracts';

/** A file the document picker handed back: the app's own copy of it. */
export interface PickedAsset {
  uri: string;
  name: string;
  mimeType?: string | null;
  size?: number | null;
}

export interface UploadDeps {
  /** Opens the picker; null when the person cancels. */
  pick(): Promise<PickedAsset | null>;
  /** The picked file as a Blob of this media type. */
  read(uri: string, mediaType: string): Promise<Blob>;
  send(file: Blob): Promise<TestOrder>;
  /** Deletes the picker's copy; never throws. */
  removePicked(uri: string): void;
}

export type UploadOutcome =
  | { kind: 'cancelled' }
  | { kind: 'refused'; message: Message }
  | { kind: 'unreadable' }
  | { kind: 'uploaded'; order: TestOrder }
  | { kind: 'failed'; error: unknown };

/**
 * Pick, check, read and send one result. Whatever happens after the picker returns a file
 * (refused, unreadable, upload failed or done), its copy is deleted and the Blob closed: the
 * copy is health data in the app's storage (threat model T24).
 */
export async function pickAndUpload(deps: UploadDeps): Promise<UploadOutcome> {
  let asset: PickedAsset | null;
  try {
    asset = await deps.pick();
  } catch (error) {
    return { kind: 'failed', error };
  }
  if (!asset) return { kind: 'cancelled' };
  let file: Blob | null = null;
  try {
    // A PDF or a photo within 25 MB, before a long upload; the server checks again.
    const check = checkPickedFile(asset);
    if (!check.ok) return { kind: 'refused', message: fileCheckMessage(check.reason) };
    try {
      file = await deps.read(asset.uri, check.mediaType);
    } catch {
      return { kind: 'unreadable' };
    }
    return { kind: 'uploaded', order: await deps.send(file) };
  } catch (error) {
    return { kind: 'failed', error };
  } finally {
    // React Native keeps a Blob's bytes in its native store until it is closed.
    (file as (Blob & { close?: () => void }) | null)?.close?.();
    deps.removePicked(asset.uri);
  }
}

/**
 * The app's `tmp` folder from its caches folder on iOS (`<container>/Library/Caches` →
 * `<container>/tmp`), where the picker's `asCopy` leaves files in `<bundle-id>-Inbox`.
 * Null for any other layout.
 */
export function iosTmpUri(cacheUri: string): string | null {
  const match = /^(.*)\/Library\/Caches\/?$/.exec(cacheUri);
  return match ? `${match[1]}/tmp/` : null;
}

/** A folder iOS's document picker copies picked files into, `<bundle-id>-Inbox`. */
export const isPickerInbox = (name: string) => /.-Inbox$/.test(name);

export interface DeviceParts {
  account: { reset(): void };
  /** The shared-file caches (prescription PDFs, test results). */
  caches: { clear(): void }[];
  /** Deletes every copy the picker left behind. */
  clearPicked(): void;
}

/**
 * Signed out (or started without a session): forget the family and delete every file the
 * last session left on the phone. Each step runs even if an earlier one throws.
 */
export function clearOnSignOut(status: string, parts: DeviceParts): boolean {
  if (status === 'signed_in') return false;
  const steps = [
    () => parts.account.reset(),
    ...parts.caches.map((c) => () => c.clear()),
    () => parts.clearPicked(),
  ];
  for (const step of steps) {
    try {
      step();
    } catch {
      // Keep going: the remaining files must still go.
    }
  }
  return true;
}
