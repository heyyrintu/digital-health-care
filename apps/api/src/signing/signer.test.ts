import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TestKeySigner } from './signer';

const doctor = { userId: '00000000-0000-4000-8000-000000000001', name: 'Dr. Test' };

describe('TestKeySigner', () => {
  it('signs a digest verifiably, with a stable key per secret', async () => {
    const signer = new TestKeySigner('a-secret-of-at-least-thirty-two-chars!!');
    const digest = createHash('sha256').update('pdf bytes').digest();
    const signature = await signer.sign(digest);
    expect(signer.verify(digest, signature)).toBe(true);
    expect(signer.verify(createHash('sha256').update('other').digest(), signature)).toBe(false);

    const same = new TestKeySigner('a-secret-of-at-least-thirty-two-chars!!');
    expect(await same.certificate()).toBe(await signer.certificate());
    expect(same.verify(digest, signature)).toBe(true);
    const other = new TestKeySigner('another-secret-of-at-least-thirty-two!!');
    expect(await other.certificate()).not.toBe(await signer.certificate());
    expect(await signer.certificate(doctor)).toMatch(/^TEST KEY ed25519 [0-9a-f]{16}$/);
  });
});
