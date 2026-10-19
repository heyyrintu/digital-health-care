import { describe, expect, it, vi } from 'vitest';
import { consentDocuments, publicApiCacheSeconds } from './config';

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

describe('public API cache', () => {
  it('keeps answers five minutes unless told to keep them shorter', () => {
    expect(publicApiCacheSeconds({})).toBe(300);
    expect(publicApiCacheSeconds({ PUBLIC_API_CACHE_SECONDS: '60' })).toBe(60);
    expect(publicApiCacheSeconds({ PUBLIC_API_CACHE_SECONDS: ' 120 ' })).toBe(120);
  });

  it('goes below 60 seconds only for the browser tests', () => {
    expect(publicApiCacheSeconds({ PUBLIC_API_CACHE_SECONDS: '1', DHC_E2E: '1' })).toBe(1);
    expect(publicApiCacheSeconds({ PUBLIC_API_CACHE_SECONDS: '30', DHC_E2E: '1' })).toBe(30);
  });

  it('raises a lower value to 60 without the test flag, warning once', () => {
    const warn = vi.fn();
    expect(publicApiCacheSeconds({ PUBLIC_API_CACHE_SECONDS: '1' }, warn)).toBe(60);
    expect(publicApiCacheSeconds({ PUBLIC_API_CACHE_SECONDS: '5', DHC_E2E: 'yes' }, warn)).toBe(60);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/below 60.*DHC_E2E=1/);
  });

  it.each(['0', '-5', '301', '1.5', 'soon', ''])('ignores %j', (value) => {
    expect(publicApiCacheSeconds({ PUBLIC_API_CACHE_SECONDS: value, DHC_E2E: '1' })).toBe(300);
  });
});
