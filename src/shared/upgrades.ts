/**
 * The better gear for a slot: what the realm sells, as `gearUpgrades` lists it
 * (each item with the counter selling it and its price), and the best the
 * slot takes from anywhere, as `bestInSlot` lists it (sold, dropped, or
 * neither).
 */
import type { CharacterState } from './character';
import type { ItemEntity } from './entities';
import type { GearGain } from './gearWorth';
import type { GearTrade } from './gearWeighing';

/** An item the realm puts in a slot, and what it gives there. */
export interface GearRow {
  /** The realm's `Items` row. */
  item: number;
  name: string;
  /** Damage a round (or the mean blow) for a weapon, armour class otherwise. */
  figure: number | null;
  ac: number | null;
  dr: number | null;
  /** Armour's weighed worth in AC points (`gearWeighing.ts`, todo 117); null for a weapon. */
  worth: number | null;
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
  /** How many counters stock it; `sold` is the one least out of the way. */
  counters: number;
}

/** One slot: what is worn there. */
export interface SlotWorn {
  slot: string;
  /** The weakest worn there, which an upgrade replaces; null where nothing is worn. */
  worn: string | null;
  wornFigure: number | null;
  /** The worn item's weighed worth, armour only; null where nothing is worn or it is a weapon. */
  wornWorth: number | null;
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

/**
 * The character wearing other items, and the names that went on; one the realm
 * does not hold, not kit, or already worn in its slot did not.
 */
export interface Wearing {
  state: CharacterState;
  worn: string[];
}

/** One better item for the Gear card: where it comes from, what it gives, what this character pays. */
export interface GearChoice extends GearSource {
  /** The slot it goes in, as `SlotWorn.slot` names it. */
  slot: string;
  /** What `sold` charges this character, charm applied; null where it is not sold or not priced. */
  charged: number | null;
  gain: GearGain;
}

/** One slot on the Gear card: what is worn and the better items, best first. */
export interface GearSlot extends SlotWorn {
  /** The places of the slot's kind (two ring fingers). */
  places: number;
  items: GearChoice[];
}

/** The Gear card's reading for one character. */
export interface GearChoices {
  slots: GearSlot[];
  /** Where class, race, level or alignment is unread, so a row may be refused that would not be. */
  unread: boolean;
}

/** Why a floor item better than what is worn is left lying (`FloorGear`). */
export type FloorRefusal =
  'heavy' | 'ceiling' | 'unread' | 'classUnread' | 'kit' | 'hands' | 'locked';

/**
 * What an item on the floor is to the character's gear (todo 77): better than
 * the weakest worn in its slot, or filling an empty place, and so worth taking
 * and wearing; or better and left lying, with why. Null where it is no better,
 * not worn gear, or not usable by this character.
 */
export type FloorGear =
  | {
      kind: 'better';
      slot: string;
      /** The weakest worn, which it outranks; null where a place in the slot is empty. */
      over: string | null;
      /** What comes off first where the slot has several places, all worn (`WearWanted.replaces`). */
      replaces: string | null;
      hands: 1 | 2 | null;
      /** What wearing it over `over` gains and gives up, by the weights; null with a place free or in the weapon hand. */
      trade: GearTrade | null;
    }
  | {
      kind: 'refused';
      slot: string;
      why: FloorRefusal;
      /**
       * The worn item a gear set keeps, the hand item a two-hander or an off-hand
       * item cannot share, the saved item a death holds the slot for, or the
       * armour an unread class leaves on; null otherwise.
       */
      worn: string | null;
    };

/** The loot's question about a floor item, composed by the session (`session/floorGearReader.ts`). */
export type FloorGearReader = (floor: ItemEntity, state: CharacterState) => FloorGear | null;
