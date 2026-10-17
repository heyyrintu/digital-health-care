import { describe, expect, it } from 'vitest';
import { forwardedClientIp } from './session-server';

describe('forwardedClientIp', () => {
  it('passes on nothing unless FORWARD_CLIENT_IP is on', () => {
    expect(forwardedClientIp('203.0.113.7', false)).toBeNull();
  });

  it('passes on only the entry the load balancer wrote, never ones the client sent', () => {
    expect(forwardedClientIp('10.9.9.9, 198.51.100.1, 203.0.113.7', true)).toBe('203.0.113.7');
    expect(forwardedClientIp(' 203.0.113.7 ', true)).toBe('203.0.113.7');
    expect(forwardedClientIp('10.9.9.9,', true)).toBeNull();
    expect(forwardedClientIp(null, true)).toBeNull();
  });
});
