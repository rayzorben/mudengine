import { describe, expect, it } from 'vitest';

import { addressKey } from '../address';

describe('the key an address is counted under', () => {
  it('is an IPv4 address as it is, mapped into IPv6 or not', () => {
    expect(addressKey('203.0.113.9')).toBe('203.0.113.9');
    expect(addressKey('::ffff:203.0.113.9')).toBe('203.0.113.9');
  });

  it('is the /64 of an IPv6 address, however it is written', () => {
    expect(addressKey('2001:db8:1:2::1')).toBe('2001:db8:1:2::/64');
    expect(addressKey('2001:0db8:0001:0002:ffff:0:0:9')).toBe('2001:db8:1:2::/64');
    expect(addressKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(addressKey('::1')).toBe('0:0:0:0::/64');
    expect(addressKey('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
    expect(addressKey('2001:db8:1:2:3:4:1.2.3.4')).toBe('2001:db8:1:2::/64');
  });

  it('is anything else as it was given', () => {
    expect(addressKey('unknown')).toBe('unknown');
  });
});
