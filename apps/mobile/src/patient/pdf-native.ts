import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Platform } from 'react-native';
import { PdfCache } from './pdf-cache';
import { PDF_FOLDER } from './pdf-name';

const folder = () => new Directory(Paths.cache, PDF_FOLDER);

/** The Patient app's prescription PDF cache, on expo-file-system and expo-sharing. */
export const prescriptionPdfs = new PdfCache({
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
  share: (uri, title) =>
    Sharing.shareAsync(uri, {
      mimeType: 'application/pdf',
      UTI: 'com.adobe.pdf',
      dialogTitle: title,
    }),
  keepAfterShare: Platform.OS === 'android',
});

/**
 * The PDF's bytes. React Native's Blob has no `arrayBuffer()`, but its FileReader can read
 * one; the Blob is closed afterwards so the native blob store frees the bytes at once.
 */
export async function blobBytes(blob: Blob): Promise<Uint8Array> {
  try {
    if (typeof blob.arrayBuffer === 'function') return new Uint8Array(await blob.arrayBuffer());
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
      reader.onerror = () => reject(reader.error ?? new Error('Could not read the PDF.'));
      reader.readAsArrayBuffer(blob);
    });
  } finally {
    (blob as Blob & { close?: () => void }).close?.();
  }
}
