import { createHash, createPrivateKey, createPublicKey, hkdfSync, sign, verify } from 'node:crypto';

/**
 * Signs a prescription PDF on the server after the doctor approves (ADR 0008). The cloud
 * Class 3 DSC provider plugs in here; until one is chosen, development and staging use
 * a test key, which the PDF and the record label as not legally valid.
 */
export interface PrescriptionSigner {
  readonly method: 'test_key' | 'cloud_dsc';
  /** The certificate that will sign for this doctor, printed on the PDF before signing. */
  certificate(doctor: { userId: string; name: string }): Promise<string>;
  /** Signs the SHA-256 of the finished PDF; returns the signature, base64. */
  sign(digest: Buffer, doctor: { userId: string; name: string }): Promise<string>;
}

// PKCS#8 wrapper for a raw 32-byte Ed25519 private key.
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/** Ed25519 key derived from the server secret. Not a DSC: for development and staging only. */
export class TestKeySigner implements PrescriptionSigner {
  readonly method = 'test_key' as const;
  private readonly privateKey;
  readonly publicKey;
  private readonly fingerprint: string;

  constructor(secret: string) {
    const seed = Buffer.from(hkdfSync('sha256', secret, 'dhc-signing', 'test-signing-key', 32));
    this.privateKey = createPrivateKey({
      key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
      format: 'der',
      type: 'pkcs8',
    });
    this.publicKey = createPublicKey(this.privateKey);
    const raw = this.publicKey.export({ format: 'der', type: 'spki' });
    this.fingerprint = createHash('sha256').update(raw).digest('hex').slice(0, 16);
  }

  async certificate(_doctor?: { userId: string; name: string }): Promise<string> {
    return `TEST KEY ed25519 ${this.fingerprint}`;
  }

  async sign(digest: Buffer): Promise<string> {
    return sign(null, digest, this.privateKey).toString('base64');
  }

  verify(digest: Buffer, signature: string): boolean {
    return verify(null, digest, this.publicKey, Buffer.from(signature, 'base64'));
  }
}
