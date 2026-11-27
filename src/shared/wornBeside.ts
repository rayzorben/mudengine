/**
 * An item looked up, set beside what this character wears in its slot: the
 * Reference panel's comparison. Built in main (`world/wornBeside.ts`) with
 * the floor loot's ranking (`slotGear`, `versusWorn`); drawn by
 * `ReferenceWorn`. Absent where the character cannot wear it.
 */
import type { SlotFigures, SlotGearRow, SlotRanking } from './slotGear';

/** One item worn in the slot, with what it gives there. */
export interface WornPiece {
  /** As the listing spelled it. */
  name: string;
  figures: SlotFigures;
  /** Null where the realm holds no single row for the name. */
  weight: number | null;
  speed: number | null;
}

/** How the item weighs against the piece it would replace. */
export type BesideVerdict = 'better' | 'same' | 'worse';

export interface WornBeside {
  /** The slot as `WORN_SLOT` spells it. */
  slot: string;
  ranking: SlotRanking;
  /** The item looked up, reckoned for this character. */
  item: SlotGearRow;
  /** What is worn in the slot; null until a listing has said. */
  worn: WornPiece[] | null;
  /**
   * The weakest worn, which wearing it replaces; null with a place in the slot
   * free (a second ring finger) or the pack unread.
   */
  replaces: string | null;
  /** Against `replaces`; null where it replaces nothing. */
  verdict: BesideVerdict | null;
  /** The other hand's item that has to come off first (a two-hander and a shield). */
  handsFree: string | null;
  /** Class, race, level or alignment unread: the server may still refuse it. */
  unread: boolean;
}
