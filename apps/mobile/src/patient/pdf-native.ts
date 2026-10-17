import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Platform } from 'react-native';
import { PdfCache } from './pdf-cache';
import { PDF_FOLDER } from './pdf-name';
import { RESULT_FOLDER, shareTypeOf } from './tests';
import { iosTmpUri, isPickerInbox } from './upload';

/** A cache on expo-file-system and expo-sharing, in its own folder of the app's private cache. */
function nativeCache(folderName: string): PdfCache {
  const folder = () => new Directory(Paths.cache, folderName);
  return new PdfCache({
    write(name, bytes) {
      const dir = folder();
      dir.create({ idempotent: true, intermediates: true });
      const file = new File(dir, name);
      file.write(bytes);
      return {
        uri: file.uri,
        remove() {
          try {
            if (file.exists) file.delete();
          } catch {
            // Left for the next open or sign-out, which empty the folder.
          }
        },
      };
    },
    clearAll() {
      try {
        const dir = folder();
        if (dir.exists) dir.delete();
      } catch {
        // The OS may already have cleared the cache; nothing else to do.
      }
    },
    canShare: () => Sharing.isAvailableAsync(),
    share: (uri, title, mediaType) =>
      Sharing.shareAsync(uri, {
        mimeType: mediaType,
        UTI: shareTypeOf(mediaType).uti,
        dialogTitle: title,
      }),
    keepAfterShare: Platform.OS === 'android',
  });
}

/** The Patient app's prescription PDF cache. */
export const prescriptionPdfs = nativeCache(PDF_FOLDER);

/** The Patient app's test result cache (PDFs and photos). */
export const testResultFiles = nativeCache(RESULT_FOLDER);

/**
 * The file's bytes. React Native's Blob has no `arrayBuffer()`, but its FileReader can read
 * one; the Blob is closed afterwards so the native blob store frees the bytes at once.
 */
export async function blobBytes(blob: Blob): Promise<Uint8Array> {
  try {
    if (typeof blob.arrayBuffer === 'function') return new Uint8Array(await blob.arrayBuffer());
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
      reader.onerror = () => reject(reader.error ?? new Error('Could not read the file.'));
      reader.readAsArrayBuffer(blob);
    });
  } finally {
    (blob as Blob & { close?: () => void }).close?.();
  }
}

/**
 * A picked file as a Blob to upload, typed as checked (the picker's own type can be missing
 * or generic). React Native's fetch reads a local `file://` URI into its native blob store.
 */
export async function pickedBlob(uri: string, mediaType: string): Promise<Blob> {
  const raw = await (await fetch(uri)).blob();
  if (raw.type === mediaType) return raw;
  try {
    return new Blob([raw], { type: mediaType });
  } finally {
    (raw as Blob & { close?: () => void }).close?.();
  }
}

/**
 * The picker's options: on Android it copies into `cache/DocumentPicker`. On iOS it already
 * opens with `asCopy`, which copies the file into `tmp/<bundle-id>-Inbox`; a further copy
 * into the cache would leave two, so the Inbox copy is used as it is.
 */
export const pickOptions = {
  copyToCacheDirectory: Platform.OS !== 'ios',
  multiple: false,
} as const;

/** Deletes the picker's copy of a file once it is uploaded (or refused); never throws. */
export function removePicked(uri: string): void {
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    // Left for sign-out, which empties the picker's folders.
  }
}

const removeDir = (dir: Directory) => {
  try {
    if (dir.exists) dir.delete();
  } catch {
    // The OS may already have cleared it; nothing else to do.
  }
};

/**
 * Signed out: deletes every copy the picker left behind, including one an upload interrupted
 * by the app closing left: `cache/DocumentPicker` (Android) and, on iOS, the
 * `tmp/<bundle-id>-Inbox` folders `asCopy` writes to.
 */
export function clearPickedFiles(): void {
  removeDir(new Directory(Paths.cache, 'DocumentPicker'));
  if (Platform.OS !== 'ios') return;
  try {
    const tmpUri = iosTmpUri(Paths.cache.uri);
    if (!tmpUri) return;
    const tmp = new Directory(tmpUri);
    if (!tmp.exists) return;
    for (const entry of tmp.list()) {
      if (entry instanceof Directory && isPickerInbox(entry.name)) removeDir(entry);
    }
  } catch {
    // An unreadable tmp folder: iOS empties it in time.
  }
}
