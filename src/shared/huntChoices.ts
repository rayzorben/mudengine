/**
 * The hunt's own figures, as settings (todo 118): when a better spot is worth
 * the move, what copper and a shared lair count for, and which rooms the
 * survey leaves out as too dear or too easy. The options file, the character
 * file and both settings pages read them through `huntChoices`. The why is in
 * `mudengine-automation` › `parts/loops.md` and `mudengine-world` ›
 * `parts/hunting.md`.
 */
import { fraction, int } from './values';

/** The `automation.hunting` keys todo 118 added. See `HuntingAutomationConfig`. */
export interface HuntChoices {
  /** How much more another spot must pay than this one before the hunt moves. A share. */
  moveMargin: number;
  /** Under a cash floor, the share of the best spot's exp a spot must make for its copper to count. */
  cashExpShare: number;
  /** What a spot is worth while another player is working it. A share; experience divides. */
  contestedShare: number;
  /** How far a loop that stopped for earning too little looks for a better spot, in steps. */
  betterSpotRadius: number;
  /** A room whose one visit takes more than this share of the health bar is left out. */
  maxDamageShare: number;
  /** How much lower the bar is read when a room is judged too easy to hunt. A share. */
  trivialLevelMargin: number;
}

/** Each at what the client did before it was a setting. */
export const DEFAULT_HUNT_CHOICES: HuntChoices = {
  moveMargin: 0.25,
  cashExpShare: 0.5,
  contestedShare: 0.5,
  betterSpotRadius: 80,
  maxDamageShare: 0.5,
  trivialLevelMargin: 0.05
};

/** The one whole number's bounds. */
export const HUNT_RANGES = {
  betterSpotRadius: [1, 9_999]
} as const satisfies Partial<Record<keyof HuntChoices, readonly [number, number]>>;

/** The hunt's choices out of a raw block, each defaulted and bounded. */
export function huntChoices(raw: Record<string, unknown>): HuntChoices {
  const d = DEFAULT_HUNT_CHOICES;
  return {
    moveMargin: fraction(raw['moveMargin'], d.moveMargin),
    cashExpShare: fraction(raw['cashExpShare'], d.cashExpShare),
    contestedShare: fraction(raw['contestedShare'], d.contestedShare),
    betterSpotRadius: int(
      raw['betterSpotRadius'],
      d.betterSpotRadius,
      ...HUNT_RANGES.betterSpotRadius
    ),
    maxDamageShare: fraction(raw['maxDamageShare'], d.maxDamageShare),
    trivialLevelMargin: fraction(raw['trivialLevelMargin'], d.trivialLevelMargin)
  };
}
