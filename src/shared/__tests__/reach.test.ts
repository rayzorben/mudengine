import { describe, expect, it } from 'vitest';

import { REACH_ABILITY } from '../abilities';
import { hitMagicOf, reachTarget, weaponHurts, weaponReach, type ReachWeapon } from '../reach';

const { magical, hitMagic, reqToHit, meetsReqToHit } = REACH_ABILITY;

/*
 * `Player.CanPlayerHitTarget` (GreaterMUD `Player.cs:5511`): the monster's
 * highest `Magical` against the larger of the weapon's `Magical` and the
 * attacker's `HitMagic`, then `ReqToHit` against `MeetsReqToHit`.
 */
describe('weaponHurts', () => {
  const tier = (n: number) => reachTarget([[magical, n]], true)!;

  it('hurts a monster at or under the weapon tier, and not one above it', () => {
    expect(weaponHurts(tier(3), [[magical, 3]], 0)).toBe(true);
    expect(weaponHurts(tier(4), [[magical, 3]], 0)).toBe(false);
  });

  it('lets the attacker HitMagic stand in for the weapon, and the bare hand', () => {
    expect(weaponHurts(tier(5), [[magical, 1]], 6)).toBe(true);
    expect(weaponHurts(tier(5), null, 6)).toBe(true);
    expect(weaponHurts(tier(1), null, 0)).toBe(false);
  });

  it('counts a weapon its own HitMagic', () => {
    expect(weaponHurts(tier(4), [[hitMagic, 5]], 0)).toBe(true);
  });

  it('needs a matching MeetsReqToHit where the monster has ReqToHit, whatever the tier', () => {
    const portal = reachTarget([[reqToHit, 7]], true)!;
    expect(weaponHurts(portal, [[magical, 6]], 10)).toBe(false);
    expect(weaponHurts(portal, [[meetsReqToHit, 7]], 0)).toBe(true);
  });

  it('cannot say where the rows sharing a name disagree across the weapon tier', () => {
    const folded = reachTarget(
      [
        [magical, 2],
        [magical, 5]
      ],
      true
    )!;
    expect(weaponHurts(folded, [[magical, 3]], 0)).toBeNull();
  });

  it('cannot say for an unresolved name of several rows, where a row may state no tier', () => {
    const unresolved = reachTarget([[magical, 5]], false)!;
    expect(weaponHurts(unresolved, [], 0)).toBeNull();
    expect(weaponHurts(unresolved, [[magical, 5]], 0)).toBe(true);
  });
});

describe('hitMagicOf', () => {
  it('is the highest of every source, and unknown when one is unread', () => {
    expect(hitMagicOf([[[hitMagic, 6]], [], [[hitMagic, 10]]])).toBe(10);
    expect(hitMagicOf([[], []])).toBe(0);
    expect(hitMagicOf([[[hitMagic, 6]], null])).toBeNull();
  });
});

describe('weaponReach', () => {
  const dragon = reachTarget([[magical, 5]], true);
  const club: ReachWeapon = { name: 'club', abilities: [], equipped: true };
  const pike: ReachWeapon = { name: 'golden pike', abilities: [[hitMagic, 5]], equipped: false };
  const sword: ReachWeapon = { name: 'silver sword', abilities: [[magical, 5]], equipped: false };
  const none = () => null;

  it('hurts with the hand when the hand can', () => {
    expect(weaponReach(dragon, sword, [], 0, none)).toEqual({ kind: 'hurts' });
  });

  it('picks the best carried weapon that can, by the planner worth', () => {
    const worth = (name: string) => (name === 'golden pike' ? 30 : 20);
    expect(weaponReach(dragon, club, [sword, pike], 0, worth)).toEqual({
      kind: 'swap',
      weapon: 'golden pike'
    });
  });

  it('says nothing carried can, only when every weapon was read', () => {
    expect(weaponReach(dragon, club, [], 0, none)).toEqual({ kind: 'cannot' });
    const unread: ReachWeapon = { name: 'odd blade', abilities: undefined, equipped: false };
    expect(weaponReach(dragon, club, [unread], 0, none)).toEqual({ kind: 'unknown' });
  });

  it('takes the server refusal of the hand over the rows, and swaps or gives up', () => {
    const unresolved = reachTarget([[magical, 5]], false);
    expect(weaponReach(unresolved, club, [], 0, none)).toEqual({ kind: 'unknown' });
    expect(weaponReach(unresolved, club, [sword], 0, none, true)).toEqual({
      kind: 'swap',
      weapon: 'silver sword'
    });
    expect(weaponReach(dragon, sword, [], 0, none, true)).toEqual({ kind: 'cannot' });
  });

  it('is unknown without the monster row or the attacker HitMagic', () => {
    expect(weaponReach(null, club, [], 0, none)).toEqual({ kind: 'unknown' });
    expect(weaponReach(dragon, club, [], null, none)).toEqual({ kind: 'unknown' });
  });
});
