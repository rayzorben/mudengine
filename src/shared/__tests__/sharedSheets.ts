/**
 * A sheet another player's client shares, as `Peers.sheetsFor` hands it on:
 * every field unknown but the ones a test names.
 */
import { AFFLICTION_NAMES, type Afflictions } from '../character';
import { PEER_SHEET_VERSION, type PeerSheet, type SharedSheet } from '../peers';

const REALM = 'orohost:2427';

export function sharedSheet(
  name: string,
  over: Partial<PeerSheet> & { heardAt?: number; key?: string; control?: boolean } = {}
): SharedSheet {
  const { heardAt = 1, key = `key-${name}`, control = false, ...sheet } = over;
  return {
    from: { realm: REALM, name },
    key,
    heardAt,
    control,
    sheet: {
      v: PEER_SHEET_VERSION,
      className: null,
      vitals: null,
      afflictions: null,
      buffs: null,
      inCombat: null,
      stealth: null,
      level: null,
      exp: null,
      expNeeded: null,
      room: null,
      leader: null,
      ...sheet
    }
  };
}

/** Conditions with the named ones `yes` and the rest `no`, as a sharer's own client states them. */
export function afflicted(...names: (keyof Afflictions)[]): Afflictions {
  return Object.fromEntries(
    AFFLICTION_NAMES.map((name) => [name, names.includes(name) ? 'yes' : 'no'])
  ) as unknown as Afflictions;
}
