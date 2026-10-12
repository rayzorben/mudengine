import { describe, expect, it } from 'vitest';

import { TabTraffic } from '../web/traffic';

describe('what a tab was sent', () => {
  it('tallies by channel, largest first, and starts again once taken', () => {
    const traffic = new TabTraffic();
    traffic.count('session:data', 10);
    traffic.count('patch', 300);
    traffic.count('session:data', 15);
    expect(traffic.take()).toEqual({ patch: '300/1', 'session:data': '25/2' });
    expect(traffic.take()).toEqual({});
  });
});
