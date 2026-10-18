import { describe, expect, it, vi } from 'vitest';
import { consentDocuments } from './config';

const urls = {
  PRIVACY_NOTICE_URL: ' https://example.com/privacy ',
  TERMS_URL: 'https://example.com/terms',
};

describe('consent documents', () => {
  it('reads both document links', () => {
    expect(consentDocuments({ NODE_ENV: 'production', ...urls }, vi.fn())).toEqual({
      urls: { privacy_notice: 'https://example.com/privacy', terms: 'https://example.com/terms' },
      missing: false,
    });
  });

  it('in production, without both links, refuses the consents and warns once', () => {
    const warn = vi.fn();
    const env = { NODE_ENV: 'production', PRIVACY_NOTICE_URL: urls.PRIVACY_NOTICE_URL };
    expect(consentDocuments(env, warn).missing).toBe(true);
    expect(consentDocuments({ ...env, TERMS_URL: '  ' }, warn).missing).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/PRIVACY_NOTICE_URL and TERMS_URL/);
  });

  it('outside production, lets development go on without them', () => {
    const warn = vi.fn();
    expect(consentDocuments({ NODE_ENV: 'development' }, warn)).toEqual({
      urls: { privacy_notice: undefined, terms: undefined },
      missing: false,
    });
    expect(consentDocuments({ NODE_ENV: 'test' }, warn).missing).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });
});
