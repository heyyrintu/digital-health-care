import { randomBytes } from 'node:crypto';
import { link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

/**
 * Private file storage by key, never by public URL (PRD §11). Production uses object
 * storage behind this interface; development and tests use a local directory.
 */
export interface FileStore {
  /** Stores new content under `key`. A key is written once and never overwritten. */
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
}

const KEY = /^[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9_.-]*)*$/;

/** A random suffix, so a key from a rolled-back attempt is never reused. */
export const uniqueSuffix = () => randomBytes(6).toString('hex');

export class LocalFileStore implements FileStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private path(key: string): string {
    if (!KEY.test(key) || key.includes('..')) throw new Error(`Invalid file key: ${key}`);
    const path = resolve(join(this.root, key));
    if (!path.startsWith(this.root + sep)) throw new Error(`Invalid file key: ${key}`);
    return path;
  }

  async put(key: string, data: Buffer): Promise<void> {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true });
    // Write beside it, then link into place: atomic, and fails if the key exists.
    const temp = `${path}.${uniqueSuffix()}.tmp`;
    await writeFile(temp, data, { flag: 'wx' });
    try {
      await link(temp, path);
    } finally {
      await unlink(temp).catch(() => undefined);
    }
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.path(key));
  }
}
