/**
 * The counter a cash run sells at on its way to the bank (todo 64): what the
 * pack carries that is worth a counter's while, and of the counters taking any
 * of it within `automation.outgrown.sellDetour` of the walk to the bank, the one
 * whose sale pays most. What is sold is what `OutgrownGear` would part with
 * (outgrown gear, never what a setting or an unfinished quest keeps) plus loot
 * that is no gear at all, in the same price band and rarity. The detour is the
 * engine's (`stockingPlaces` with the bank as destination).
 */
import { WEAR_SLOTS } from '../world/gearUpgrades';
import { rarityBook } from '../world/itemRarity';
import { copperOf, rarityOf } from '../world/outgrownItems';
import type { CharacterTracker } from '../parse/CharacterTracker';
import type { Traveller, WorldGraph } from '../world/WorldGraph';
import type { CashRunSale, CashRunSaleChoice, QuestKept } from '../../shared/cashRun';
import type { CharacterState } from '../../shared/character';
import { soldForCopper } from '../../shared/coins';
import type { AutomationConfig } from '../../shared/config';
import { keptRegardless, type KeptNames } from '../../shared/outgrown';
import type { OutgrownChoices } from '../../shared/packConfig';
import type { QuestKeep } from '../../shared/questKeep';
import { sheddable, type Rarity } from '../../shared/rarity';
import { entityNumber } from '../../shared/entities';
import { roomAddress, roomId, type RoomId } from '../../shared/world';
import type { Errands } from './Errands';
import { keptNow, outgrownNow, type OutgrownPlannerModules } from './outgrownPlanner';

/** What the choice reads: the character, the realm's rows and counters, and the keep rules. */
export interface SaleReads {
  current(): CharacterState;
  world: Pick<WorldGraph, 'item' | 'stockingPlaces'>;
  /** What the player's settings keep (`keptRegardless`). */
  kept(state: CharacterState): KeptNames;
  /** The names of the pack's outgrown gear that nothing keeps (`outgrownNow`). */
  outgrown(state: CharacterState): readonly string[];
  rarity(id: number): Rarity;
  traveller(state: CharacterState): Traveller;
  /** What an unfinished quest still needs (todo 52). */
  quests: QuestKeep;
  /** The price bands, the rare-gear switch and the detour (`automation.outgrown`). */
  choices: OutgrownChoices;
}

export interface SaleModules {
  world: OutgrownPlannerModules['world'];
  errands: Pick<Errands, 'travellerNow' | 'realmClass'>;
  tracker: Pick<CharacterTracker, 'current'>;
}

/** The session's modules bound into the reads; null with no realm loaded. */
export function saleReadsOf(
  m: SaleModules,
  config: AutomationConfig,
  quests: QuestKeep
): SaleReads | null {
  const world = m.world;
  if (world === undefined) return null;
  return {
    current: () => m.tracker.current,
    world,
    kept: (state) => keptNow(state, config, world),
    outgrown: (state) => outgrownNow(m, config, state).map((found) => found.item.name),
    rarity: (id) => rarityBook(world).of(id).rarity,
    traveller: (state) => m.errands.travellerNow(state),
    quests,
    choices: config.outgrown
  };
}

/** No counter, nothing kept: what a run with no realm loaded is told. */
export const NO_SALE: CashRunSaleChoice = { sale: null, questKept: [] };

interface ForSale {
  /** The carried items to sell, by realm row, as the pack names them. */
  wanted: Map<number, string>;
  /** Those that would have gone but a quest still needs. */
  questKept: QuestKept[];
}

function forSale(reads: SaleReads, state: CharacterState, tokens: readonly number[]): ForSale {
  const realm = { item: (id: number) => reads.world.item(id), rarity: reads.rarity };
  const wanted = new Map<number, string>();
  const questKept: QuestKept[] = [];
  const kept = reads.kept(state);
  const outgrown = new Set(reads.outgrown(state));
  const { sellFromCopper, stashFromCopper, keepRare } = reads.choices;
  for (const item of state.inventory.items) {
    if (keptRegardless(item, kept)) continue;
    // Gear goes only once outgrown: an unworn piece for a slot with room may still be worn.
    const gear = item.wornSlotCode !== undefined && WEAR_SLOTS.includes(item.wornSlotCode);
    if (gear && !outgrown.has(item.name)) continue;
    // A name several rows share, with no room to settle it, is not guessed at.
    const id = entityNumber(item);
    if (id === null || tokens.includes(id) || wanted.has(id)) continue;
    if (!sheddable(rarityOf(item, realm), keepRare)) continue;
    // The ganghouse's band and above is not sold at half its worth on the way past.
    const worth = copperOf(item, realm);
    if (worth === null || worth < sellFromCopper || worth >= stashFromCopper) continue;
    const quest = reads.quests.wantedBy(item);
    if (quest !== null) questKept.push({ item: item.name, quest });
    else wanted.set(id, item.name);
  }
  return { wanted, questKept };
}

/** The counter, null where nothing carried sells within the detour, and what a quest kept. */
export function saleOnTheWay(
  reads: SaleReads,
  bank: RoomId,
  tokens: readonly number[]
): CashRunSaleChoice {
  const state = reads.current();
  const here = roomAddress(state.room);
  if (here === null) return NO_SALE;
  const { wanted, questKept } = forSale(reads, state, tokens);
  const sale = wanted.size === 0 ? null : bestCounter(reads, state, wanted, here, bank);
  return { sale, questKept };
}

/** Of the counters within the detour that take any of `wanted`, the one paying most. */
function bestCounter(
  reads: SaleReads,
  state: CharacterState,
  wanted: ReadonlyMap<number, string>,
  here: RoomId,
  bank: RoomId
): CashRunSale | null {
  const { world } = reads;
  const { sellDetour } = reads.choices;
  const charm = state.progress.charm;
  const counters = new Map<RoomId, CashRunSale & { detour: number }>();
  const places = world.stockingPlaces([...wanted.keys()], here, bank, reads.traveller(state), true);
  for (const place of places) {
    const name = wanted.get(place.item);
    if (place.detour > sellDetour || name === undefined) continue;
    const row = world.item(place.item);
    if (row?.price === undefined || row.currency === undefined) continue;
    const room = roomId(place.map, place.room);
    const at = counters.get(room) ?? {
      room,
      shop: place.shop,
      items: [],
      copper: 0,
      detour: place.detour
    };
    // A row two counters in one room both take is sold once.
    if (at.items.includes(name)) continue;
    at.items.push(name);
    at.copper += soldForCopper(row.price, row.currency, charm);
    counters.set(room, at);
  }
  let best: (CashRunSale & { detour: number }) | null = null;
  for (const at of counters.values()) {
    const better =
      best === null ||
      at.copper > best.copper ||
      (at.copper === best.copper && at.detour < best.detour);
    if (better) best = at;
  }
  if (best === null) return null;
  return { room: best.room, shop: best.shop, items: best.items, copper: best.copper };
}
