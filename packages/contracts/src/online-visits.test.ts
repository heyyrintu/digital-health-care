import { expect, it } from 'vitest';
import { isMeetingUrl, onlineAgeAt, OnlineIntake, ONLINE_CONSENT_VERSION } from './online-visits';
it('allows HTTPS meeting providers and rejects credentials, ports, fragments and lookalike hosts', () => {
  for (const url of [
    'https://meet.google.com/abc-defg-hij',
    'https://zoom.us/j/123456789?pwd=synthetic',
    'https://us06web.zoom.us/j/123456789',
    'https://teams.microsoft.com/l/meetup-join/synthetic/0',
  ])
    expect(isMeetingUrl(url)).toBe(true);
  for (const url of [
    'https://evil.test/call',
    'javascript:alert(1)',
    'http://meet.google.com/abc-defg-hij',
    'https://meet.google.com.evil.test/call',
    'https://person@zoom.us/j/123',
    'https://zoom.us:444/j/123',
    'https://zoom.us/j/123#secret',
  ])
    expect(isMeetingUrl(url)).toBe(false);
});
it('requires explicit versioned consent and authority', () => {
  expect(
    OnlineIntake.safeParse({
      version: 0,
      consentVersion: ONLINE_CONSENT_VERSION,
      agreed: false,
      identity: {},
    }).success,
  ).toBe(false);
});

it('checks adulthood at the India calendar birthday boundary', () => {
  expect(onlineAgeAt('2008-11-07', new Date('2026-11-06T19:00:00Z'))).toBe(18);
  expect(onlineAgeAt('2008-11-08', new Date('2026-11-06T19:00:00Z'))).toBe(17);
  expect(onlineAgeAt('2008-11-07', new Date('2026-11-06T18:00:00Z'))).toBe(17);
});
