/**
 * How rare an item is: the hours to one copy at its quickest source, and a
 * band read from them. The sources and their figures are worked out from the
 * world database by `world/itemRarity.ts`; this is the rule over them. See
 * `mudengine-world` › *An item's rarity is its quickest source*.
 */
import type { RoomId } from './world';

export const RARITY_BANDS = ['common', 'uncommon', 'rare', 'veryRare', 'extremelyRare'] as const;
export type RarityBand = (typeof RARITY_BANDS)[number];
/** A band, or `unknown` where no source is rated: every reader keeps an unknown item. */
export type Rarity = RarityBand | 'unknown';

/** The upper bound of each band but the last, in hours to one copy (`tuning.rarity`). */
export interface RarityThresholds {
  commonHours: number;
  uncommonHours: number;
  rareHours: number;
  veryRareHours: number;
}

/**
 * What a typed phrase asks before it hands anything over: nothing (on
 * demand), an item it uses up, or a quest flag (an ability verb), which is
 * labelled rather than timed.
 */
export type RarityGate =
  { kind: 'onDemand' } | { kind: 'uses'; items: string[] } | { kind: 'quest' };

/** When a monster's spell runs: on arriving, on dying, between rounds, or as a blow. */
export type MonsterRun = 'arrive' | 'death' | 'fight' | 'attack';

/** One way the realm makes the item, with what decides its figure. */
export type RarityFrom =
  | { kind: 'shop'; shop: string; amount: number; percent: number; minutes: number }
  | { kind: 'placed'; room: RoomId }
  | { kind: 'drop'; monster: string; percent: number }
  /** `copies` is how many one run makes on average; a fight's is per round. */
  | { kind: 'spell'; monster: string; when: MonsterRun; copies: number }
  | { kind: 'use'; item: string; copies: number }
  | { kind: 'ask'; who: string; say: string; gate: RarityGate; copies: number }
  /** A phrase typed in any of `rooms`. */
  | { kind: 'say'; rooms: [RoomId, ...RoomId[]]; say: string; gate: RarityGate; copies: number };

/** A source and the hours to one copy from it; null where it has no figure. */
export interface RaritySource {
  hours: number | null;
  from: RarityFrom;
}

export interface ItemRarity {
  rarity: Rarity;
  /** Hours to one copy at the quickest source, or null where none is rated. */
  hours: number | null;
  /** `Items.Limit` caps how many the realm holds: never below rare. */
  limited: boolean;
  /** Every source, quickest first, those with no figure last. */
  sources: RaritySource[];
}

/** The band an hours figure falls in. */
export function bandOf(hours: number, bounds: RarityThresholds): RarityBand {
  if (hours < bounds.commonHours) return 'common';
  if (hours < bounds.uncommonHours) return 'uncommon';
  if (hours < bounds.rareHours) return 'rare';
  if (hours < bounds.veryRareHours) return 'veryRare';
  return 'extremelyRare';
}

const isQuest = (from: RarityFrom): boolean =>
  (from.kind === 'ask' || from.kind === 'say') && from.gate.kind === 'quest';

/**
 * The rarity of an item from its sources. The quickest single source decides,
 * never their sum: a character farms one place, and forty lairs dropping it at
 * 1% are not common to anyone hunting one of them. An item had only as a
 * quest reward is rare with no hours; one with no source at all is unknown.
 */
export function itemRarity(
  sources: readonly RaritySource[],
  limited: boolean,
  bounds: RarityThresholds
): ItemRarity {
  const ordered = [...sources].sort((a, b) => (a.hours ?? Infinity) - (b.hours ?? Infinity));
  const hours = ordered[0]?.hours ?? null;
  const found: Rarity =
    hours !== null
      ? bandOf(hours, bounds)
      : ordered.some((source) => isQuest(source.from))
        ? 'rare'
        : 'unknown';
  const rarity =
    limited && (found === 'common' || found === 'uncommon' || found === 'unknown') ? 'rare' : found;
  return { rarity, hours, limited, sources: ordered };
}
