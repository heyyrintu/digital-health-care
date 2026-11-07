import { expect, it } from 'vitest';
import { isGoogleReviewUrl, ReviewSettingsBody, ReviewConsentBody } from './reviews';
it('accepts only direct Google review destinations and rejects redirect/credential/query tricks', () => {
  for (const value of [
    'https://g.page/r/ExampleId/review',
    'https://search.google.com/local/writereview?placeid=ChIJExample',
  ])
    expect(isGoogleReviewUrl(value)).toBe(true);
  for (const value of [
    'https://evil.test/review',
    'https://g.page.evil.test/r/Example/review',
    'https://g.page/r/Example/review?url=https://evil.test',
    'https://search.google.com/url?q=https://evil.test',
    'https://search.google.com/local/writereview?placeid=ChIJExample&url=https://evil.test',
    'https://user:pass@g.page/r/Example/review',
    'http://g.page/r/Example/review',
    'https://g.page/r/Example/review#other',
    'https://g.page:8443/r/Example/review',
  ])
    expect(isGoogleReviewUrl(value)).toBe(false);
});
it('requires explicit optional consent and bounded cooldowns', () => {
  expect(ReviewConsentBody.safeParse({ enabled: true }).success).toBe(false);
  expect(ReviewConsentBody.safeParse({ enabled: false }).success).toBe(true);
  expect(
    ReviewSettingsBody.safeParse({ version: 0, enabled: true, googleUrl: null, cooldownDays: 90 })
      .success,
  ).toBe(false);
  expect(
    ReviewSettingsBody.safeParse({
      version: 0,
      enabled: true,
      googleUrl: 'https://g.page/r/ExampleId/review',
      cooldownDays: 29,
    }).success,
  ).toBe(false);
});
