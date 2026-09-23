/**
 * `stat all` — the server's own arithmetic for this character, and when it
 * stops being true.
 *
 * `Player.ShowStatAll` prints accuracy, swings, the blow's range and both
 * regeneration rates as the server computes them, gear and spells included:
 * the terms `prowess.ts` cannot enumerate and so answers as floors. Read off
 * the `user-stat-all` batch into `CharacterState.stated`; `statedNow` hands
 * the figures on only while what they were computed from is as it was.
 *
 * See `mudengine-wire` › *`stat all` is the server's arithmetic, true until
 * what it was computed from moves*.
 */
import type { CharacterState } from './character';

/** The plain round's row — `WriteCombatBeforeDefenses` / `…AfterDefenses`. */
export interface StatedRound {
  /** Blows a round, uncapped: `PlayerAttackType.Swings`, a fraction. */
  swings: number;
  /** `Acc + AttackTypeAccMod` — the character's own on either form of the sheet. */
  accuracy: number;
  /**
   * The blow's range. Before any defence on the character's own sheet; on one
   * run against a monster, after its damage resistance and floored at zero.
   */
  min: number;
  max: number;
}

/**
 * What the figures were computed from, as two strings.
 *
 * `gear` is what every figure moves with: level, the six attributes, the
 * class, what is worn and which effects are up. `load` adds the pack's share
 * and the party rank, which move accuracy and swings and nothing else
 * (`Player.CalcAccuracy`, `CalcEnergyUsedWithEncum`).
 */
export interface StatedBasis {
  gear: string;
  load: string;
}

export interface StatedSheet {
  /** The monster the tables were run against (`stat all <id>`), or null. */
  against: string | null;
  /** `HP Regen: n/3n` — a tick standing, and a tick resting. */
  healthRegen: number | null;
  restingRegen: number | null;
  /**
   * `MA Regen: base/with bonus`. The server's passive tick adds the second
   * (`MARegen`) and its meditation tick the first (`GetBaseMARegen`).
   */
  baseManaRegen: number | null;
  manaRegen: number | null;
  round: StatedRound | null;
  basis: StatedBasis;
}

/** What of a sheet still holds for the character as it stands now. */
export interface StatedProwess {
  accuracy?: number;
  swings?: number;
  health?: number;
  resting?: number;
  /** Mana a passive tick returns, and a meditating one. */
  mana?: number;
  meditating?: number;
  /** The plain round's range, off the character's own sheet only. */
  damage?: { min: number; max: number };
}

type BasisState = Pick<CharacterState, 'progress' | 'inventory'> &
  Partial<Pick<CharacterState, 'buffs' | 'className' | 'party' | 'name'>>;

export function statedBasis(state: BasisState): StatedBasis {
  const { progress, inventory } = state;
  // A burning light is `equipped` and moves no figure; `wieldedWeapon`'s rule.
  const worn = inventory.items
    .filter((item) => item.equipped && item.kind !== 'light')
    .map((item) => `${item.name}@${item.slot ?? ''}`)
    .sort();
  const effects = (state.buffs ?? []).map((buff) => buff.spell).sort();
  const gear = JSON.stringify([
    progress.level,
    progress.strength,
    progress.agility,
    progress.intellect,
    progress.willpower,
    progress.health,
    progress.charm,
    state.className ?? null,
    worn,
    effects
  ]);
  const { encumbrance, encumbranceMax } = inventory;
  const share =
    encumbrance === null || encumbranceMax === null || encumbranceMax <= 0
      ? null
      : Math.trunc((100 * encumbrance) / encumbranceMax);
  const own = state.party?.members.find((member) => member.name === state.name);
  return { gear, load: `${gear}|${JSON.stringify([share, own?.rank ?? null])}` };
}

/**
 * The sheet's figures, where they still hold — `null` when there is no sheet
 * or nothing it states is still true.
 *
 * **A figure is dropped the moment what it was computed from moves**, and
 * never adjusted: a server figure nudged by the client's arithmetic is the
 * client's figure wearing the server's name. The formulas answer instead,
 * and say they are floors.
 */
export function statedNow(
  state: BasisState & Partial<Pick<CharacterState, 'stated'>>
): StatedProwess | null {
  const sheet = state.stated;
  if (sheet === undefined || sheet === null) return null;
  const now = statedBasis(state);
  if (now.gear !== sheet.basis.gear) return null;
  const figures: StatedProwess = {};
  if (sheet.healthRegen !== null) figures.health = sheet.healthRegen;
  if (sheet.restingRegen !== null) figures.resting = sheet.restingRegen;
  /*
   * A KaiBound Mystic's `MARegen` is `-1` (`Player.cs`, the `KaiBind`
   * branch): a sentinel, not a rate, so it states nothing.
   */
  if (sheet.manaRegen !== null && sheet.manaRegen >= 0) figures.mana = sheet.manaRegen;
  if (sheet.baseManaRegen !== null && sheet.baseManaRegen >= 0) {
    figures.meditating = sheet.baseManaRegen;
  }
  const round = sheet.round;
  // Against a monster the range is after its resistance: not the character's.
  if (round !== null && sheet.against === null) {
    figures.damage = { min: round.min, max: round.max };
  }
  if (round !== null && now.load === sheet.basis.load) {
    figures.accuracy = round.accuracy;
    figures.swings = round.swings;
  }
  return Object.keys(figures).length === 0 ? null : figures;
}

/**
 * The batch's rows, read in order.
 *
 * An `Attack` row after the `Spells` heading is a spell whose short name
 * happens to be the title, and is not read.
 */
export function readStatAll(
  rows: ReadonlyArray<Record<string, string>>,
  basis: StatedBasis
): StatedSheet | null {
  const whole = (value: string | undefined): number | null => {
    if (value === undefined) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const sheet: StatedSheet = {
    against: null,
    healthRegen: null,
    restingRegen: null,
    baseManaRegen: null,
    manaRegen: null,
    round: null,
    basis
  };
  let table: 'none' | 'attacks' | 'spells' = 'none';
  for (const row of rows) {
    if (row['section'] === 'Attacks') {
      table = 'attacks';
      sheet.against = row['against']?.trim() || null;
      continue;
    }
    if (row['section'] === 'Spells') {
      table = 'spells';
      continue;
    }
    if (row['healthRegen'] !== undefined) {
      sheet.healthRegen = whole(row['healthRegen']);
      sheet.restingRegen = whole(row['restingRegen']);
    }
    if (row['manaRegen'] !== undefined) {
      sheet.baseManaRegen = whole(row['baseManaRegen']);
      sheet.manaRegen = whole(row['manaRegen']);
    }
    if (row['swings'] === undefined || table !== 'attacks' || sheet.round !== null) continue;
    const swings = whole(row['swings']);
    const accuracy = whole(row['accuracy']);
    const min = whole(row['min']);
    const max = whole(row['max']);
    if (swings === null || accuracy === null || min === null || max === null) continue;
    sheet.round = { swings, accuracy, min, max };
  }
  const anything = sheet.healthRegen !== null || sheet.manaRegen !== null || sheet.round !== null;
  return anything ? sheet : null;
}
