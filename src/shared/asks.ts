/**
 * What the client asks the realm on its own to keep the cards current, as
 * settings (todo 118): `i`, `st` and `exp` again once their answer is old,
 * `who` while the who list is out of date, `abil`, the spell list, `st` when a
 * buff is ending, `stat a`, and a look at a charged item. A fact never asked
 * stays unknown on the cards. The options file, the character file and both
 * settings pages read it through `normalizeAsks`. The why is in
 * `mudengine-automation` › *A routine reacts to what happens*.
 */
import { bool, int, isRecord, minutesMs } from './values';

export interface AsksConfig {
  /** Minutes an inventory (`i`) may get before it is asked again. 0 never asks. */
  inventoryMinutes: number;
  /** Minutes a stat sheet (`st`) may get before it is asked again. 0 never asks. */
  statsMinutes: number;
  /** Minutes `exp` may get before it is asked again. 0 never asks. */
  expMinutes: number;
  /** The fewest minutes between two `who` asks while the who list is out of date. 0 never asks. */
  whoMinutes: number;
  /** `abil` once a session, when a gated way needs the quest counters. */
  abilities: boolean;
  /** `spells` or `powers` once the prompt says which, and again when the book changes. */
  spellbook: boolean;
  /** `st` when a line may have ended a buff, so the sheet's effects say which. */
  statsOnBuffEnding: boolean;
  /** `stat a` once for each mix of what the character is, wears and has up. */
  statAll: boolean;
  /** `look` at a charged item whose uses are unknown, once a session. */
  itemUses: boolean;
}

/** Each at what the client did before it was a setting. */
export const DEFAULT_ASKS: AsksConfig = {
  inventoryMinutes: 2,
  statsMinutes: 5,
  expMinutes: 5,
  whoMinutes: 1,
  abilities: true,
  spellbook: true,
  statsOnBuffEnding: true,
  statAll: true,
  itemUses: true
};

/** The minute figures' bounds: a day at most. */
export const ASKS_RANGES = {
  inventoryMinutes: [0, 1440],
  statsMinutes: [0, 1440],
  expMinutes: [0, 1440],
  whoMinutes: [0, 1440]
} as const satisfies Partial<Record<keyof AsksConfig, readonly [number, number]>>;

/** The block out of whatever the file or the window holds, each key defaulted and bounded. */
export function normalizeAsks(value: unknown): AsksConfig {
  const raw = isRecord(value) ? value : {};
  const d = DEFAULT_ASKS;
  const minutes = (key: keyof typeof ASKS_RANGES): number =>
    int(raw[key], d[key], ...ASKS_RANGES[key]);
  return {
    inventoryMinutes: minutes('inventoryMinutes'),
    statsMinutes: minutes('statsMinutes'),
    expMinutes: minutes('expMinutes'),
    whoMinutes: minutes('whoMinutes'),
    abilities: bool(raw['abilities'], d.abilities),
    spellbook: bool(raw['spellbook'], d.spellbook),
    statsOnBuffEnding: bool(raw['statsOnBuffEnding'], d.statsOnBuffEnding),
    statAll: bool(raw['statAll'], d.statAll),
    itemUses: bool(raw['itemUses'], d.itemUses)
  };
}

/** A period in minutes as milliseconds; 0, never asking, is never due. */
export function askEveryMs(minutes: number): number {
  return minutes > 0 ? minutesMs(minutes) : Infinity;
}
