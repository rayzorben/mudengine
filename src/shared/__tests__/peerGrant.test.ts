import { describe, expect, it } from 'vitest';

import { normalizeConfig } from '../config';
import { asPeerGrant, NO_PEER_GRANT, withPinnedKey, writtenPeerGrant } from '../peerGrant';

const KEY = 'A'.repeat(43);
const OTHER = 'B'.repeat(43);

describe("a player's sharing row", () => {
  it('reads an absent field as off, and refuses a field of the wrong type', () => {
    expect(asPeerGrant({})).toEqual(NO_PEER_GRANT);
    expect(asPeerGrant({ share: 'state', receive: true, keys: [KEY, KEY] })).toEqual({
      share: 'state',
      receive: true,
      keys: [KEY]
    });
    expect(asPeerGrant({ share: 'control' })).toBeNull();
    expect(asPeerGrant({ receive: 'yes' })).toBeNull();
    expect(asPeerGrant({ keys: ['not a key'] })).toBeNull();
  });

  it('is off by default in the options file, and a row that does not read shares nothing', () => {
    const config = normalizeConfig({
      peers: {},
      automation: {
        remotes: {
          players: {
            Soul: { share: 'state', keys: [KEY] },
            Rand: { share: 'state', keys: ['wrong'] }
          }
        }
      }
    });
    expect(config.peers.enabled).toBe(false);
    expect(config.automation.remotes.players['soul']).toMatchObject({
      share: 'state',
      keys: [KEY]
    });
    expect(config.automation.remotes.players['rand']).toMatchObject(NO_PEER_GRANT);
  });

  it('is written only where it says something, and pins a key once', () => {
    expect(writtenPeerGrant(NO_PEER_GRANT)).toEqual({});
    const pinned = withPinnedKey(withPinnedKey(NO_PEER_GRANT, KEY), KEY);
    expect(pinned.keys).toEqual([KEY]);
    expect(writtenPeerGrant(withPinnedKey({ ...pinned, share: 'state' }, OTHER))).toEqual({
      share: 'state',
      keys: [KEY, OTHER]
    });
  });
});
