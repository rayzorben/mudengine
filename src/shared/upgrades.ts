/**
 * The better gear for a slot: what the realm sells, as `gearUpgrades` lists it
 * (each item with the counter selling it and its price), and the best the
 * slot takes from anywhere, as `bestInSlot` lists it (sold, dropped, or
 * neither).
 */
import type { CharacterState } from './character';

/** An item the realm puts in a slot, and what it gives there. */
export interface GearRow {
  /** The realm's `Items` row. */
  item: number;
  name: string;
  /** Damage a round (or the mean blow) for a weapon, armour class otherwise. */
  figure: number | null;
  ac: number | null;
  dr: number | null;
  minLevel: number | null;
}

/** Where a counter sells an item, and for how much. */
export interface GearCounter {
  shop: string;
  at: { map: number; room: number };
  moves: number;
  /** The counter's price before charm; null where the realm does not say. */
  copper: number | null;
}

/** One better item for a slot, and where it is sold. */
export interface GearOffer extends GearRow, GearCounter {}

/** One better item for a slot from anywhere: the counter selling it and the monsters dropping it. */
export interface GearSource extends GearRow {
  /** The counter least out of the way that stocks it, or null where none does. */
  sold: GearCounter | null;
  /** The monsters whose drop list names it, as the realm names them. */
  droppedBy: readonly string[];
}

/** One slot: what is worn there. */
export interface SlotWorn {
  slot: string;
  /** The weakest worn there, which an upgrade replaces; null where nothing is worn. */
  worn: string | null;
  wornFigure: number | null;
  /**
   * Places in the slot nothing is worn in (a second ring finger): an offer
   * there fills one and replaces nothing.
   */
  free: number;
  /** The worn item's damage resistance as the realm states it; null where it does not. */
  wornDr: number | null;
  ranking: 'armour' | 'weapon';
}

/** One slot: what is worn and what the realm sells that is better. */
export interface SlotUpgrade extends SlotWorn {
  /** Best first; the cheapest this character can wear now comes last where it is not among them. */
  offers: GearOffer[];
}

/** One slot: what is worn and the best the character can wear there, from anywhere. */
export interface SlotBest extends SlotWorn {
  /** Better than what is worn, best first, none above the character's level. */
  items: GearSource[];
}

/** The character wearing other items, and the names that went on; one the realm does not hold, or not kit, did not. */
export interface Wearing {
  state: CharacterState;
  worn: string[];
}
