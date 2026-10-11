/**
 * The session's answer to `AutoCombatEvents.reach` (todo 46): the room's
 * monster row, the pack's weapons, the class and race rows, the worn items
 * other than the weapon and the active spells, handed to `weaponReach`.
 * The ranking is the gear planner's own (`GearReads.attacks` holding each
 * weapon), so a swap picks what the Gear card would.
 */
import type { CarriedItem, CharacterState } from '../../shared/character';
import { heldWeapon } from '../../shared/gear';
import {
  hitMagicOf,
  reachTarget,
  REACH_UNKNOWN,
  weaponReach,
  type ReachWeapon,
  type WeaponReach
} from '../../shared/reach';
import { mobKey } from '../../shared/world';
import type { WorldGraph } from '../world/WorldGraph';
import type { Errands } from './Errands';
import type { GearReads } from './gearReads';

/** An item's rows, or null where the realm has none for a name off the wire. */
function unreadAsNull(item: CarriedItem): NonNullable<CarriedItem['abilities']> | null {
  return item.abilities ?? (item.source === 'wire' ? null : []);
}

export function handReach(
  errands: Pick<Errands, 'capabilities'>,
  world: () => Pick<WorldGraph, 'spellNamed'> | undefined,
  gear: () => Pick<GearReads, 'attacks' | 'wearing'>
): (state: CharacterState, target: string, handRefused: boolean) => WeaponReach {
  return (state, target, handRefused) => {
    const key = mobKey(target);
    const mob = state.room.occupants.find((who) => who.kind === 'mob' && mobKey(who.name) === key);
    const items = state.inventory.items;
    if (mob?.mob === undefined || state.inventory.listedAt === null) return REACH_UNKNOWN;
    const hand = heldWeapon(items);
    const worn = items.filter((item) => item.equipped && item !== hand);
    const hitMagic = hitMagicOf([
      errands.capabilities().abilities,
      ...worn.map((item) => unreadAsNull(item)),
      ...(state.buffs ?? []).map((buff) => world()?.spellNamed(buff.spell)?.abilities ?? null)
    ]);
    const asWeapon = (item: CarriedItem): ReachWeapon => ({
      name: item.name,
      abilities: unreadAsNull(item) ?? undefined,
      equipped: item.equipped
    });
    // An item the realm cannot name may be a weapon: carried as unread, never refusing.
    const carried = items.filter(
      (item) =>
        !item.equipped &&
        (item.kind === 'weapon' || (item.kind === undefined && item.source === 'wire'))
    );
    const rank = (weapon: string): number | null => {
      const reads = gear();
      const held = reads.wearing([weapon], state);
      if (held.worn.length === 0) return null;
      const best = reads
        .attacks(held.state, [target])
        .map((option) => option.perRound?.value ?? null)
        .filter((value): value is number => value !== null);
      return best.length === 0 ? null : Math.max(...best);
    };
    // One row's own figures: a room resolved it, or the name has only the one.
    const oneRow = mob.mob.row !== undefined || (mob.mob.ids?.length ?? 1) <= 1;
    return weaponReach(
      reachTarget(mob.mob.abilities ?? (mob.mob.source === 'wire' ? undefined : []), oneRow),
      hand === undefined ? null : asWeapon(hand),
      carried.map(asWeapon),
      hitMagic,
      rank,
      handRefused
    );
  };
}
