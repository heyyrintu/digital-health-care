import { lstat, mkdir, open, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, join } from 'node:path';
import {
  Catalogue,
  FILES,
  MAX_FILE_BYTES,
  Manifest,
  digest,
  stageCatalogue,
  compareCatalogues,
  type FileName,
} from './catalogue';

async function readBounded(path: string, limit: number) {
  // No symlinks or devices. Check the opened descriptor as well as the directory entry.
  const info = await lstat(path);
  if (!info.isFile() || info.size > limit)
    throw new Error(`Expected a regular file within its size limit: ${path}`);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error('Source file changed while opening.');
    const bytes = await handle.readFile();
    if (bytes.length > limit) throw new Error('Source file grew beyond its limit.');
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } finally {
    await handle.close();
  }
}

export async function stageDirectory(inputPath: string, outputPath: string, previousPath?: string) {
  const input = resolve(inputPath),
    output = resolve(outputPath);
  const manifest = Manifest.parse(
    JSON.parse((await readBounded(join(input, 'manifest.json'), 16_384)).replace(/^\uFEFF/, '')),
  );
  const files = {} as Record<FileName, string>;
  let totalBytes = 0;
  for (const file of Object.keys(FILES) as FileName[]) {
    const text = await readBounded(join(input, file), MAX_FILE_BYTES);
    totalBytes += Buffer.byteLength(text);
    if (totalBytes > 64 * 1024 * 1024) throw new Error('Source package exceeds 64 MiB.');
    files[file] = text;
  }
  const staged = stageCatalogue(manifest, files);
  const delta = previousPath
    ? compareCatalogues(staged.catalogue, await previousCatalogue(previousPath))
    : null;
  // mkdir is exclusive: never overwrite an existing report or source directory.
  await mkdir(output, { mode: 0o700 });
  const checksums: Record<string, string> = {};
  const artifacts = {
    'catalogue.json': staged.catalogue,
    'report.json': staged.report,
    'provenance.json': staged.provenance,
    ...(delta ? { 'delta.json': delta } : {}),
  };
  for (const [name, value] of Object.entries(artifacts)) {
    const text = JSON.stringify(value, null, 2) + '\n';
    if (Buffer.byteLength(text) > 256 * 1024 * 1024)
      throw new Error('Staging artifact exceeds 256 MiB.');
    await writeFile(join(output, name), text, { flag: 'wx', mode: 0o600 });
    checksums[name] = digest(text);
  }
  // A failed write leaves an incomplete directory. Readers must require this final marker.
  await writeFile(
    join(output, 'COMPLETE.json'),
    JSON.stringify({ fingerprint: staged.catalogue.fingerprint, sha256: checksums }, null, 2) +
      '\n',
    { flag: 'wx', mode: 0o600 },
  );
  return {
    output,
    fingerprint: staged.catalogue.fingerprint,
    candidateBrands: staged.report.candidateBrands,
    rejectedBrands: staged.report.rejectedBrands,
    issues: staged.report.issues.length,
    publicationAllowed: false,
    ...(delta ? { delta } : {}),
  };
}

/** Only read a previously completed artifact, and verify its checksum before diffing. */
export async function previousCatalogue(directory: string) {
  const marker = JSON.parse(await readBounded(join(resolve(directory), 'COMPLETE.json'), 16_384));
  const text = await readBounded(join(resolve(directory), 'catalogue.json'), 64 * 1024 * 1024);
  if (
    typeof marker.sha256?.['catalogue.json'] !== 'string' ||
    marker.sha256['catalogue.json'] !== digest(text)
  )
    throw new Error('Previous catalogue is incomplete or has a checksum mismatch.');
  const catalogue = Catalogue.parse(JSON.parse(text));
  if (marker.fingerprint !== catalogue.fingerprint)
    throw new Error('Previous catalogue fingerprint mismatch.');
  return catalogue;
}
