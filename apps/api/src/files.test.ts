import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalFileStore } from './files';

describe('LocalFileStore', () => {
  it('stores and reads by key, never overwrites, and rejects keys outside its folder', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dhc-files-'));
    const store = new LocalFileStore(root);
    await store.put('org/a/rx-1.pdf', Buffer.from('one'));
    expect((await store.get('org/a/rx-1.pdf')).toString()).toBe('one');
    await expect(store.put('org/a/rx-1.pdf', Buffer.from('two'))).rejects.toThrow();
    expect((await store.get('org/a/rx-1.pdf')).toString()).toBe('one');
    expect(await readdir(join(root, 'org/a'))).toEqual(['rx-1.pdf']);
    for (const key of ['../x', 'org/../../x', '/etc/passwd', 'Org/A', 'org//a']) {
      await expect(store.put(key, Buffer.from('x'))).rejects.toThrow('Invalid file key');
    }
  });
});
