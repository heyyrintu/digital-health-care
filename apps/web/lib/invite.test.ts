import { describe, expect, it } from 'vitest';
import {
  groupKey,
  isSixDigitCode,
  newPasswordError,
  readInviteToken,
  secretFromOtpauth,
} from './invite';

describe('readInviteToken', () => {
  const token = 'aB3_-'.repeat(8) + 'xyz';

  it('reads a token from the fragment', () => {
    expect(readInviteToken(`#${token}`)).toBe(token);
  });

  it('rejects empty, short or malformed fragments', () => {
    expect(readInviteToken('')).toBeNull();
    expect(readInviteToken('#')).toBeNull();
    expect(readInviteToken('#short')).toBeNull();
    expect(readInviteToken('#<script>alert(1)</script>xxxxxxxxxxxxxxxx')).toBeNull();
  });
});

describe('secretFromOtpauth', () => {
  it('extracts the secret', () => {
    expect(secretFromOtpauth('otpauth://totp/DHC%3Aa%40b.test?secret=JBSWY3DP&issuer=DHC')).toBe(
      'JBSWY3DP',
    );
  });

  it('returns null for anything else', () => {
    expect(secretFromOtpauth('not a uri')).toBeNull();
  });
});

describe('form checks', () => {
  it('groups the manual key in fours', () => {
    expect(groupKey('JBSWY3DPEHPK3PXP')).toBe('JBSW Y3DP EHPK 3PXP');
  });

  it('checks new passwords for length then match', () => {
    expect(newPasswordError('short', 'short')).toBe('invite.passwordTooShort');
    expect(newPasswordError('long enough passphrase', 'different passphrase')).toBe(
      'invite.passwordMismatch',
    );
    expect(newPasswordError('long enough passphrase', 'long enough passphrase')).toBeNull();
  });

  it('accepts only six digits as a code', () => {
    expect(isSixDigitCode('123456')).toBe(true);
    expect(isSixDigitCode('12345')).toBe(false);
    expect(isSixDigitCode('12a456')).toBe(false);
  });
});
