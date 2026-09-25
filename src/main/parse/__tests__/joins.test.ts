import { describe, expect, it } from 'vitest';

import {
  EMPTY_CHARACTER,
  type CarriedItem,
  type CharacterState,
  type RoomOccupant
} from '../../../shared/character';
import type { EntitySource, MobEntity } from '../../../shared/entities';
import { withPackRows, withSight, withSpans, withTargetEntity } from '../joins';

/*
 * What the commit point's joins hand back when nothing they state moved
 * (todo 700: *order is a decision*; the identity is what keeps a status line
 * from pushing a state). The tracker's tests read the joined fields, which a
 * join that rebuilt the state every time would pass. So these hand each join
 * a realm lookup that writes down what it was asked, and check the identity.
 */

/** Carrying `items`, of race `race`. */
function character(race: string | null, ...items: CarriedItem[]): CharacterState {
  const s = structuredClone(EMPTY_CHARACTER);
  return { ...s, phase: 'in-game', race, inventory: { ...s.inventory, items } };
}
const ROPE = { name: 'rope', count: 1, equipped: false, slot: null } as CarriedItem;

describe('what the joins hand back', () => {
  it('sight: nothing before a race or a pack, and the same state when it did not move', () => {
    const asked: string[] = [];
    const world = { raceAbilities: (race: string) => (asked.push(race), []) };
    const bare = character(null);
    expect(withSight(bare, world)).toBe(bare);
    expect(asked).toEqual([]);
    const human = withSight(character('Human', ROPE), world);
    expect(human.sight).not.toBeNull();
    expect(withSight(human, world)).toBe(human);
    expect(asked).toEqual(['Human', 'Human']);
    expect(withSight({ ...human, race: null, inventory: bare.inventory }, world).sight).toBeNull();
  });

  it('pack rows: both halves asked, and the same state for the same rows', () => {
    const asked: string[][] = [];
    const world = {
      itemIdsCarried: (items: ReadonlyArray<{ name: string }>) => {
        asked.push(items.map((item) => item.name));
        return [7];
      }
    };
    const s = {
      ...character(null, ROPE),
      inventory: { ...character(null, ROPE).inventory, keys: ['bone key'] }
    };
    const joined = withPackRows(s, world);
    expect(joined.inventory.rows).toEqual([7]);
    expect(withPackRows(joined, world)).toBe(joined);
    expect(asked).toEqual([
      ['rope', 'bone key'],
      ['rope', 'bone key']
    ]);
    expect(withPackRows(joined, undefined).inventory.rows).toEqual([]);
  });

  it('spans: the same state while there are none to state', () => {
    const world = { raceSpans: () => null };
    const s = character('Human');
    expect(withSpans(s, world)).toBe(s);
    expect(withSpans(s, undefined)).toBe(s);
  });

  it('target: no row for a player, none for the wire’s own, and none without a realm', () => {
    const asked: string[] = [];
    /** A realm that builds a whole row of `source` for any name, and writes down each ask. */
    const built = (source: EntitySource) => ({
      buildMobEntity: (name: string): MobEntity => {
        asked.push(name);
        return {
          name,
          rawName: name,
          source,
          charmed: false,
          disposition: null,
          uncertain: false,
          costly: 'never'
        };
      }
    });
    const s = character(null);
    const rat = { ...s, combat: { ...s.combat, target: 'giant rat' } };
    expect(withTargetEntity(rat, built('mdb')).combat.targetEntity).toMatchObject({
      name: 'giant rat'
    });
    expect(withTargetEntity(rat, built('wire')).combat.targetEntity).toBeNull();
    const player: RoomOccupant = {
      name: 'Soul',
      kind: 'player',
      disposition: null,
      uncertain: false,
      costly: 'never',
      charmed: false,
      hidden: false,
      free: false
    };
    const soul: CharacterState = {
      ...rat,
      combat: { ...rat.combat, target: 'Soul' },
      room: { ...rat.room, occupants: [player] }
    };
    expect(withTargetEntity(soul, built('mdb')).combat.targetEntity).toBeNull();
    expect(asked).toEqual(['giant rat', 'giant rat']);
    expect(withTargetEntity(rat, undefined)).toBe(rat);
  });
});
