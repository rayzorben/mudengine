/**
 * The character's gear as the realm ranks it, for the Gear card and for an
 * extension alike: what each slot could hold (`bestInSlot`), what a counter
 * sells (`gearUpgrades`), the character wearing other items (`wearing`) and
 * the attacks it can make (`attackOptions`), each for the character as it
 * stands or as a hypothetical `as`. Out of the extension wiring, so the card
 * reads the same answers an extension does.
 */
import type { AttackOption } from '../../shared/attackOptions';
import type { CharacterState } from '../../shared/character';
import { chargedInCopper } from '../../shared/coins';
import { placesOf, sheetGain } from '../../shared/gearWorth';
import type { GearChoices, SlotBest, SlotUpgrade, Wearing } from '../../shared/upgrades';
import { roomAddress } from '../../shared/world';
import type { ExtensionWorld } from '../extensions/api';
import type { CharacterTracker } from '../parse/CharacterTracker';
import { bestInSlot } from '../world/bestInSlot';
import { gearUpgrades, type UpgradeRealm } from '../world/gearUpgrades';
import { slotAskerOf, type SlotAsker } from '../world/slotGear';
import { wearing } from '../world/wearing';
import type { Errands } from './Errands';

export interface GearReadParts {
  tracker: Pick<CharacterTracker, 'current'>;
  errands: Pick<Errands, 'realmClass' | 'capabilities' | 'travellerNow' | 'priceAt' | 'words'>;
  world(): ExtensionWorld | undefined;
}

export interface GearReads {
  gearUpgrades(perSlot: number, as?: CharacterState): SlotUpgrade[];
  bestInSlot(perSlot: number, as?: CharacterState): SlotBest[];
  wearing(items: readonly string[], as?: CharacterState): Wearing;
  attacks(as?: CharacterState, against?: readonly string[]): AttackOption[];
  /**
   * The Gear card's reading: `bestInSlot` with what each item gives on the
   * sheet (a weapon's round measured by the best attack holding it) and what
   * this character pays for it.
   */
  choices(perSlot: number): GearChoices;
}

/** The realm's gear as the slot rankings read it, priced from where `state` stands; null unplaced. */
export function gearRealmOf(
  state: CharacterState,
  world: ExtensionWorld,
  errands: GearReadParts['errands']
): UpgradeRealm | null {
  const here = roomAddress(state.room);
  if (here === null) return null;
  const traveller = errands.travellerNow(state);
  return {
    itemsWornIn: (worn) => world.itemsWornIn(worn),
    stockingPlaces: (items) => world.stockingPlaces(items, here, null, traveller),
    priceAt: (name, at) => errands.priceAt(name, at)
  };
}

/** The monsters whose drop list names an item of this name, in `world`. */
export function dropsIn(world: ExtensionWorld): (item: string) => readonly string[] {
  return (item) => world.buildItemEntity(item).droppedBy ?? [];
}

export function gearReads(parts: GearReadParts): GearReads {
  const { tracker, errands } = parts;
  const askerOf = (state: CharacterState, world: ExtensionWorld): SlotAsker => {
    const fought = errands.realmClass();
    return slotAskerOf(state, world, fought, fought.verb);
  };
  const gearRealm = (state: CharacterState, world: ExtensionWorld): UpgradeRealm | null =>
    gearRealmOf(state, world, errands);
  const reads: Omit<GearReads, 'choices'> = {
    gearUpgrades: (perSlot, as) => {
      const world = parts.world();
      const state = as ?? tracker.current;
      const realm = world === undefined ? null : gearRealm(state, world);
      if (world === undefined || realm === null) return [];
      return gearUpgrades(state, realm, askerOf(state, world), perSlot);
    },
    bestInSlot: (perSlot, as) => {
      const world = parts.world();
      const state = as ?? tracker.current;
      const realm = world === undefined ? null : gearRealm(state, world);
      if (world === undefined || realm === null) return [];
      const dropsOf = dropsIn(world);
      return bestInSlot(state, { ...realm, dropsOf }, askerOf(state, world), perSlot);
    },
    wearing: (items, as) => {
      const world = parts.world();
      const state = as ?? tracker.current;
      if (world === undefined) return { state, worn: [] };
      const realm = {
        itemsWornIn: (worn: number) => world.itemsWornIn(worn),
        buildItemEntity: (name: string) => world.buildItemEntity(name)
      };
      return wearing(state, items, realm, askerOf(state, world));
    },
    attacks: (as, against = []) => errands.words.options(as ?? tracker.current, against)
  };
  /** The best attack's damage a round, as the character stands or as `as`; null where unknown. */
  const bestRound = (as?: CharacterState): number | null => {
    let best: number | null = null;
    for (const option of reads.attacks(as)) {
      const value = option.perRound?.value;
      if (value !== undefined && (best === null || value > best)) best = value;
    }
    return best;
  };
  return {
    ...reads,
    choices: (perSlot) => {
      const state = tracker.current;
      const world = parts.world();
      const wearer = world === undefined ? null : askerOf(state, world).wearer;
      const unread =
        wearer === null ||
        [wearer.classId, wearer.raceId, wearer.level, wearer.alignment].includes(null);
      const bare = bestRound();
      const slots = reads.bestInSlot(perSlot).map((slot) => ({
        ...slot,
        places: placesOf(slot.slot),
        items: slot.items.map((item) => {
          const held = slot.ranking === 'weapon' ? reads.wearing([item.name]) : null;
          const then = held === null || held.worn.length === 0 ? null : bestRound(held.state);
          const copper = item.sold?.copper ?? null;
          return {
            ...item,
            slot: slot.slot,
            charged: copper === null ? null : chargedInCopper(copper, state.progress.charm),
            gain: sheetGain(slot, item, bare === null || then === null ? null : then - bare)
          };
        })
      }));
      return { slots, unread };
    }
  };
}
