/**
 * The realm's half of the armour a room calls for (todo 69): what a room
 * deals by element, off its own spell and its lair, and a carried item's
 * resistances, slot and armour. Out of `Errands` so the session wires one
 * call; the choice is `shared/placeGear.ts`.
 */
import { tuning } from '../app/tuning';
import type { PlaceGearSources } from '../automation/PlaceGear';
import { exposureAt } from '../../shared/placeGear';
import type { WorldGraph } from '../world/WorldGraph';
import type { Errands } from './Errands';

type PlaceWorld = Pick<WorldGraph, 'byId' | 'spellById' | 'lairOf' | 'itemsNamed'>;

export function placeReads(
  world: () => PlaceWorld | undefined,
  errands: Pick<Errands, 'gearSlotOf'>
): PlaceGearSources {
  return {
    exposureAt: (room) => {
      const realm = world();
      const found = realm?.byId(room);
      if (realm === undefined || found === undefined) return null;
      const spell = found.spell === undefined ? null : realm.spellById(found.spell);
      const lair = found.lair === undefined ? [] : realm.lairOf(found);
      return exposureAt(spell, lair, (id) => realm.spellById(id));
    },
    placeItem: (item) => {
      const slot = errands.gearSlotOf(item.name);
      const row = world()?.itemsNamed([item.name])[item.name];
      // A weapon is left out: changing one changes the damage a round as well
      // as the resistance, and which way that trade goes is todo 69's open question 1.
      if (slot === null || row === undefined || row.weapon !== undefined) return null;
      return {
        name: item.name,
        slot: slot.toLowerCase(),
        equipped: item.equipped,
        abilities: row.abilities,
        armour: row.armour === undefined ? null : { ac: row.armour.ac ?? 0, dr: row.armour.dr ?? 0 }
      };
    },
    minSaved: () => tuning().placeGear.minSaved
  };
}
