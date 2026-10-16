import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { PDF_FOLDER } from './pdf-name';

/**
 * Signed prescription PDFs the patient opens, kept only while they look at them (threat
 * model T13): written to a folder in the app's cache, handed to the OS viewer or share sheet,
 * and deleted when the sheet closes; signing out empties the folder.
 */
const folder = () => new Directory(Paths.cache, PDF_FOLDER);

/** Bumped by `clearPrescriptionPdfs`, so a download that finishes after sign-out is dropped. */
let generation = 0;

/** False where the OS has no viewer or share sheet to hand a file to. */
export const canOpenPdfs = (): Promise<boolean> => Sharing.isAvailableAsync();

/**
 * Downloads a PDF, writes it as `name` and opens it in the OS viewer or share sheet; resolves
 * once the sheet closes and the copy is deleted. Resolves without opening when the person
 * signed out meanwhile.
 */
export async function openPdf(
  name: string,
  download: () => Promise<Blob>,
  dialogTitle: string,
): Promise<void> {
  const started = generation;
  const bytes = await blobBytes(await download());
  if (started !== generation) return;
  const dir = folder();
  dir.create({ idempotent: true, intermediates: true });
  const file = new File(dir, name);
  try {
    file.write(bytes);
    await Sharing.shareAsync(file.uri, {
      mimeType: 'application/pdf',
      UTI: 'com.adobe.pdf',
      dialogTitle,
    });
  } finally {
    // Best effort: signing out deletes anything left behind.
    try {
      if (file.exists) file.delete();
    } catch {
      // Left for clearPrescriptionPdfs.
    }
  }
}

/** Signed out: delete every PDF this app wrote. Never throws. */
export function clearPrescriptionPdfs(): void {
  generation += 1;
  try {
    const dir = folder();
    if (dir.exists) dir.delete();
  } catch {
    // The OS may already have cleared the cache; nothing else to do.
  }
}

/** React Native's Blob has no `arrayBuffer()`; its FileReader can read one. */
function blobBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === 'function') {
    return blob.arrayBuffer().then((buffer) => new Uint8Array(buffer));
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the PDF.'));
    reader.readAsArrayBuffer(blob);
  });
}
