import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { resolve, join } from 'node:path';
import { createDb } from '@dhc/db';
import { ImportManifest } from '@dhc/contracts';
import { readBounded, readBoundedBytes } from '../modules/medicine-staging/directory';
import {
  FILES,
  MAX_FILE_BYTES,
  digest,
  stageImportCatalogue,
  type FileName,
} from '../modules/medicine-staging/catalogue';
import { importMedicineRelease } from '../modules/medicine-import/importer';

// Explicit owner connection only. No .env auto-loading, deployment or publication.
try {
  const { values } = parseArgs({
    options: {
      input: { type: 'string' },
      archive: { type: 'string' },
      'operator-email': { type: 'string' },
      'package-sha256': { type: 'string' },
      'acknowledge-pending-licence': { type: 'boolean' },
      help: { type: 'boolean' },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help)
    process.stdout.write(
      'Private medicine import: --input <seven files + License.txt + manifest.json> --archive <original package file> --operator-email <existing platform operator> --package-sha256 <archive SHA-256> --acknowledge-pending-licence. Requires explicit DATABASE_URL (owner). Never activates prescribing.\n',
    );
  else {
    if (
      !values.input ||
      !values.archive ||
      !values['operator-email'] ||
      !values['package-sha256'] ||
      !values['acknowledge-pending-licence'] ||
      !process.env.DATABASE_URL
    )
      throw new Error('Supply all import options and an explicit owner DATABASE_URL. Use --help.');
    const input = resolve(values.input);
    const archiveHash = digest(await readBoundedBytes(resolve(values.archive), 64 * 1024 * 1024));
    if (archiveHash !== values['package-sha256'])
      throw new Error('Original package checksum does not match --package-sha256.');
    const manifest = ImportManifest.parse(
      JSON.parse((await readBounded(join(input, 'manifest.json'), 16384)).replace(/^\uFEFF/, '')),
    );
    const licenceText = await readBounded(join(input, 'License.txt'), 128 * 1024);
    if (!licenceText.trim()) throw new Error('The source package licence must be retained.');
    const files = {} as Record<FileName, string>;
    let bytes = 0;
    for (const file of Object.keys(FILES) as FileName[]) {
      files[file] = await readBounded(join(input, file), MAX_FILE_BYTES);
      bytes += Buffer.byteLength(files[file]);
      if (bytes > 64 * 1024 * 1024) throw new Error('Source package exceeds 64 MiB.');
    }
    const parsed = stageImportCatalogue(manifest, files, { includeSourceRows: true });
    const db = createDb(process.env.DATABASE_URL);
    try {
      const operator = await db.platformOperator.findUnique({
        where: { email: values['operator-email'].trim().toLowerCase() },
      });
      if (!operator) throw new Error('Create the owning platform operator first.');
      const result = await importMedicineRelease(db, parsed, {
        operatorId: operator.id,
        packageSha256: archiveHash,
        licenceTextSha256: digest(licenceText),
        audit: {
          id: randomUUID(),
          ip: '127.0.0.1',
          headers: { 'user-agent': 'dhc-owner-medicine-import' },
        },
      });
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    } finally {
      await db.$disconnect();
    }
  }
} catch (error) {
  // Database errors may include SQL/data/connection details. Do not print their raw text.
  console.error(
    error instanceof Error && error.constructor === Error
      ? error.message
      : 'Medicine import failed; no partial release was committed.',
  );
  process.exitCode = 1;
}
