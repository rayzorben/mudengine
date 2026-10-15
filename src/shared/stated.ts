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
import { loadPercent } from './load';
import type { AttackKind } from './prowess';

/**
 * The rows `Player.ShowStatAll` prints under `Attacks:`, by the title it
 * prints, and the attack each is. A Mystic's sheet adds the three martial
 * rows; `Backstab` is one blow, not a round, and nothing reads it.
 */
export const STATED_ATTACK_ROWS: Readonly<Record<string, AttackKind>> = {
  Attack: 'attack',
  Bash: 'bash',
  Smash: 'smash',
  Punch: 'punch',
  Kick: 'kick',
  Jumpkick: 'jumpkick'
};

/** One attack's row — `WriteCombatBeforeDefenses` / `…AfterDefenses`. */
export interface StatedRound {
  /** Blows a round, uncapped: `PlayerAttackType.Swings`, a fraction. */
  swings: number;
  /** `Acc + AttackTypeAccMod`: the accuracy this attack rolls with, on either form of the sheet. */
  accuracy: number;
  /**
   * The blow's range, the attack's multipliers applied. Before any defence on
   * the character's own sheet; on one run against a monster, after its damage
   * resistance and floored at zero. A bash rolls its multiplier between two
   * ends, so its row is the base's low at 2.5× and its high at 3×
   * (`prowess.spreadOf`), and its mean is under the row's middle.
   */
  min: number;
  max: number;
  /**
   * `QnD(Total)`'s total, `PlayerAttackType.GetCrits`: the stats, gear,
   * spells, class rows and quick-and-deadly, capped. Null where the server
   * blanks it (a bash or a smash cannot crit) and on a sheet run against a
   * monster, where the column is the share of every swing that crits.
   */
  crits: number | null;
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
  /** Each attack's row the sheet printed. */
  rounds: Partial<Record<AttackKind, StatedRound>>;
  basis: StatedBasis;
}

/** What of one attack's row still holds. */
export interface StatedAttack {
  accuracy?: number;
  swings?: number;
  /** The range, off the character's own sheet only. */
  damage?: { min: number; max: number };
  /** Per cent of landed blows that crit, off the character's own sheet only. */
  crits?: number;
}

/** What of a sheet still holds for the character as it stands now. */
export interface StatedProwess {
  health?: number;
  resting?: number;
  /** Mana a passive tick returns, and a meditating one. */
  mana?: number;
  meditating?: number;
  attacks?: Partial<Record<AttackKind, StatedAttack>>;
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
  const share = loadPercent(encumbrance, encumbranceMax);
  const own = state.party?.members.find((member) => member.name === state.name);
  return { gear, load: `${gear}|${JSON.stringify([share, own?.rank ?? null])}` };
}

/**
 * The most sheets kept at once. A loop's blessings come and go in the same few
 * sets, so a sheet asked once for each set holds again whenever that set is up:
 * 11.4 hours of Rayzor on Paradigm (2026-10-10) met six (todo 45's `basis-changes.mjs`).
 * In `shared/`, which cannot read `tuning:`, so the figure lives here.
 */
export const STATED_SHEETS_KEPT = 16;

/**
 * The sheets with `sheet` added, newest first: one per basis, the one it
 * replaces dropped, the oldest past `STATED_SHEETS_KEPT` dropped. A sheet a
 * player asked against a monster (`stat all <number>`) is not kept: nothing
 * reads one yet (todo 45, open question 1), and it must not displace the own.
 */
export function keepSheet(
  sheets: readonly StatedSheet[] | null,
  sheet: StatedSheet
): readonly StatedSheet[] | null {
  if (sheet.against !== null) return sheets;
  const others = (sheets ?? []).filter((kept) => kept.basis.gear !== sheet.basis.gear);
  return [sheet, ...others].slice(0, STATED_SHEETS_KEPT);
}

/**
 * The character's own sheet (`stat all` with no monster) computed from what
 * it wears, is and has up now, or null. A sheet run against a monster is never
 * the character's: its range is after that monster's resistance.
 */
export function ownSheetFor(
  state: BasisState & Partial<Pick<CharacterState, 'stated'>>
): StatedSheet | null {
  const sheets = state.stated;
  if (sheets === undefined || sheets === null) return null;
  const { gear } = statedBasis(state);
  return sheets.find((sheet) => sheet.against === null && sheet.basis.gear === gear) ?? null;
}

/**
 * The own sheet's figures, where they still hold — `null` when no sheet was
 * computed from what the character wears, is and has up now, or nothing it
 * states is still true.
 *
 * **A figure is dropped the moment what it was computed from moves**, and
 * never adjusted: a server figure nudged by the client's arithmetic is the
 * client's figure wearing the server's name. The formulas answer instead,
 * and say they are floors.
 */
export function statedNow(
  state: BasisState & Partial<Pick<CharacterState, 'stated'>>
): StatedProwess | null {
  const sheet = ownSheetFor(state);
  if (sheet === null) return null;
  const now = statedBasis(state);
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
  // Crits move with the load too: quick-and-deadly is the energy six blows leave.
  const loaded = now.load === sheet.basis.load;
  const attacks: Partial<Record<AttackKind, StatedAttack>> = {};
  for (const [kind, round] of Object.entries(sheet.rounds) as Array<[AttackKind, StatedRound]>) {
    const held: StatedAttack = { damage: { min: round.min, max: round.max } };
    if (loaded) {
      held.accuracy = round.accuracy;
      held.swings = round.swings;
      if (round.crits !== null) held.crits = round.crits;
    }
    if (Object.keys(held).length > 0) attacks[kind] = held;
  }
  if (Object.keys(attacks).length > 0) figures.attacks = attacks;
  return Object.keys(figures).length === 0 ? null : figures;
}

/**
 * The batch's rows, read in order.
 *
 * A row after the `Spells` heading whose short name happens to be an attack's
 * title is a spell, and is not read.
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
    rounds: {},
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
    const kind = STATED_ATTACK_ROWS[row['attack'] ?? ''];
    if (kind === undefined || table !== 'attacks' || sheet.rounds[kind] !== undefined) continue;
    const swings = whole(row['swings']);
    const accuracy = whole(row['accuracy']);
    const min = whole(row['min']);
    const max = whole(row['max']);
    if (swings === null || accuracy === null || min === null || max === null) continue;
    const crits = sheet.against === null ? whole(row['crits']) : null;
    sheet.rounds[kind] = { swings, accuracy, min, max, crits };
  }
  const anything =
    sheet.healthRegen !== null || sheet.manaRegen !== null || Object.keys(sheet.rounds).length > 0;
  return anything ? sheet : null;
}
