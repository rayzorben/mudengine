/**
 * The best a character can wear in each slot from anywhere in the realm: the
 * rows better than what is worn (`scanSlots`, the same test `gearUpgrades`
 * makes), none above the character's level, each with the counter that sells
 * it and the monsters whose drop list names it. What a player means by best
 * in slot; `gearUpgrades` is the half cash can fetch.
 */
import type { CharacterState } from '../../shared/character';
import type { GearSource, SlotBest } from '../../shared/upgrades';
import {
  counterOf,
  gearRowOf,
  nearestCounters,
  scanSlots,
  wearableAt,
  type UpgradeRealm
} from './gearUpgrades';
import type { SlotAsker } from './slotGear';

export interface BestRealm extends UpgradeRealm {
  /** The monsters whose drop list names an item of this name. */
  dropsOf(item: string): readonly string[];
}

/** Each slot's better items from anywhere, best first, at most `perSlot` of them. */
export function bestInSlot(
  state: CharacterState,
  realm: BestRealm,
  asker: SlotAsker,
  perSlot: number
): SlotBest[] {
  const level = state.progress.level;
  const slots = scanSlots(state, realm, asker).map((slot) => ({
    ...slot,
    // Unknown level never refuses, as the equip check does not.
    better: slot.better
      .filter((row) => level === null || wearableAt(row.minLevel, level))
      .slice(0, perSlot)
  }));
  const places = realm.stockingPlaces([
    ...new Set(slots.flatMap((slot) => slot.better.map((row) => row.id)))
  ]);
  const nearest = nearestCounters(places);
  const counters = new Map<number, number>();
  for (const place of places) counters.set(place.item, (counters.get(place.item) ?? 0) + 1);
  return slots.flatMap(({ worn, better }): SlotBest[] => {
    if (better.length === 0 && worn.worn === null) return [];
    const items = better.map((row): GearSource => {
      const place = nearest.get(row.id);
      return {
        ...gearRowOf(row),
        sold: place === undefined ? null : counterOf(place, row.name, realm),
        droppedBy: realm.dropsOf(row.name),
        counters: counters.get(row.id) ?? 0
      };
    });
    return [{ ...worn, items }];
  });
}
