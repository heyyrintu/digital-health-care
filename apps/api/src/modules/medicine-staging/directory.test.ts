import {
  cp,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { stageDirectory } from './directory';
import { validateReviewBundle } from '../medicine-review/service';
import { digest } from './catalogue';

let root: string, input: string, output: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dhc-synthetic-catalogue-'));
  input = join(root, 'input');
  output = join(root, 'stage');
  await cp(new URL('../../../test/fixtures/cdci-synthetic/', import.meta.url), input, {
    recursive: true,
  });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

it('writes a private completed stage with source provenance and output checksums', async () => {
  const result = await stageDirectory(input, output);
  expect(result.candidateBrands).toBe(2);
  expect(result.rejectedBrands).toBe(1);
  expect(result.publicationAllowed).toBe(false);
  expect(result.reviewBundleAvailable).toBe(true);
  const bundle = validateReviewBundle(
    JSON.parse(await readFile(join(output, 'review-bundle.json'), 'utf8')),
  );
  expect(bundle.catalogue.records).toHaveLength(2);
  const complete = JSON.parse(await readFile(join(output, 'COMPLETE.json'), 'utf8'));
  for (const [file, checksum] of Object.entries(complete.sha256)) {
    expect(digest(await readFile(join(output, file)))).toBe(checksum);
    expect((await stat(join(output, file))).mode & 0o777).toBe(0o600);
  }
  expect((await stat(output)).mode & 0o777).toBe(0o700);
  const provenance = JSON.parse(await readFile(join(output, 'provenance.json'), 'utf8'));
  expect(Object.keys(provenance.fileSha256)).toHaveLength(7);
});

it('does not overwrite an existing completed stage', async () => {
  await stageDirectory(input, output);
  const original = await readFile(join(output, 'COMPLETE.json'), 'utf8');
  await expect(stageDirectory(input, output)).rejects.toThrow();
  expect(await readFile(join(output, 'COMPLETE.json'), 'utf8')).toBe(original);
});

it('records the original file checksum including its UTF-8 BOM', async () => {
  const path = join(input, 'ProductMaster.txt'),
    raw = await readFile(path);
  await writeFile(path, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), raw]));
  await stageDirectory(input, output);
  const provenance = JSON.parse(await readFile(join(output, 'provenance.json'), 'utf8'));
  expect(provenance.fileSha256['ProductMaster.txt']).toBe(digest(await readFile(path)));
});

it('refuses real-data manifests before creating any output', async () => {
  const file = join(input, 'manifest.json'),
    manifest = JSON.parse(await readFile(file, 'utf8'));
  await writeFile(file, JSON.stringify({ ...manifest, dataKind: 'real' }));
  await expect(stageDirectory(input, output)).rejects.toThrow();
  expect(await readdir(root)).toEqual(['input']);
});

it('rejects symlinks and invalid UTF-8 instead of reading arbitrary or corrupted sources', async () => {
  const file = join(input, 'BrandMaster.txt');
  await rm(file);
  await symlink(join(input, 'GenericMaster.txt'), file);
  await expect(stageDirectory(input, output)).rejects.toThrow('regular file');
  await rm(file);
  await writeFile(file, Buffer.from([0xff, 0xfe, 0xc0]));
  await expect(stageDirectory(input, output)).rejects.toThrow();
});

it('requires a completed, checksum-valid previous stage for comparison', async () => {
  await stageDirectory(input, output);
  const next = join(root, 'next');
  const r = await stageDirectory(input, next, output);
  expect(r.delta?.unchanged).toHaveLength(2);
  await writeFile(join(output, 'catalogue.json'), '{}');
  await expect(stageDirectory(input, join(root, 'bad'), output)).rejects.toThrow('checksum');
  await rm(join(next, 'COMPLETE.json'));
  await expect(stageDirectory(input, join(root, 'bad'), next)).rejects.toThrow();
});

it('rejects oversized source files before writing output', async () => {
  await truncate(join(input, 'BrandMaster.txt'), 33 * 1024 * 1024);
  await expect(stageDirectory(input, output)).rejects.toThrow('size limit');
  expect(await readdir(root)).toEqual(['input']);
});

it('rejects a marker whose fingerprint disagrees with its catalogue', async () => {
  await stageDirectory(input, output);
  const path = join(output, 'COMPLETE.json'),
    marker = JSON.parse(await readFile(path, 'utf8'));
  await writeFile(path, JSON.stringify({ ...marker, fingerprint: '0'.repeat(64) }));
  await expect(stageDirectory(input, join(root, 'next'), output)).rejects.toThrow('fingerprint');
});

it('runs the operator command without database configuration and rejects publication flags', async () => {
  const run = promisify(execFile),
    entry = new URL('../../scripts/stage-medicines.ts', import.meta.url);
  const args = ['--import', 'tsx', entry.pathname];
  const result = await run(process.execPath, [...args, '--input', input, '--output', output], {
    env: { ...process.env, DATABASE_URL: 'invalid-database-url-must-not-be-read' },
  });
  expect(JSON.parse(result.stdout)).toMatchObject({
    candidateBrands: 2,
    publicationAllowed: false,
  });
  await expect(
    run(process.execPath, [...args, '--publish', '--input', input, '--output', join(root, 'live')]),
  ).rejects.toMatchObject({ code: 1 });
  expect(await readdir(root)).not.toContain('live');
});
