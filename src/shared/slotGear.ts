/**
 * What a slot's quick view shows: every item the realm puts in one slot that
 * this character can use, best first. Built in main (`world/slotGear.ts`),
 * where the realm, the stat sheet and the attack verb all are; drawn by
 * `SlotQuickView`. See `mudengine-ui` › *tables* and `gear.ts` for who may use
 * what.
 */
import type { Reckoning, SwingMethod } from './prowess';

/** How a slot's items are put in order. */
export type SlotRanking =
  /** Armour class, then damage resistance. */
  | { by: 'armour' }
  /**
   * Damage a round swung the way the character attacks (`combat.attack`), or,
   * where `rounds` is false because no round could be worked out (a realm
   * other than GreaterMUD, a sheet not read), the mean blow.
   */
  | { by: 'weapon'; method: SwingMethod; rounds: boolean };

export interface SlotGearRow {
  /** The realm's `Items` row. */
  id: number;
  name: string;
  minLevel: number | null;
  ac: number | null;
  dr: number | null;
  /** A weapon's range, `Min`–`Max`. */
  damage: { min: number; max: number } | null;
  /** A weapon's `Speed`; lower is faster. */
  speed: number | null;
  /** `roundDamage`, or null where the sheet or the realm family cannot say. */
  perRound: Reckoning<number> | null;
}

export interface SlotGear {
  /** The slot as `WORN_SLOT` spells it. */
  slot: string;
  ranking: SlotRanking;
  /** Usable rows, best first. */
  rows: SlotGearRow[];
  /** How many of the slot's rows this character can't use, and so are not listed. */
  refused: number;
  /**
   * Whether the class, race, level or alignment is still unknown. Unknown
   * refuses nothing, so the list may hold items the server will refuse.
   */
  unread: boolean;
}

/** A weapon's mean blow off its stated range: the tie-break and the Dmg column's sort. */
export function meanBlow(damage: SlotGearRow['damage']): number | null {
  return damage === null ? null : (damage.min + damage.max) / 2;
}
