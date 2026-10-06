/**
 * What a spell's script does to whoever it is cast on, as far as a way is
 * concerned. A cast exit runs its spell after the step (`CastExit.cs:36`), and
 * the script's lines run in order: the first whose steps all succeed is the one
 * that happens, and a run where every line fails moves nobody. So a script is
 * its lines, each as the gates ahead of its first moving step and whether it
 * moves. The pyramid's fourth-floor arch is `checkability 134 9:addexp 0`
 * ahead of two lines that cast `arch fail`, a random teleport. Read at build,
 * because `TBInfo` does not ship.
 */
import { HAZARD_ABILITY } from '../../../shared/abilities';
import type { Requirement, ScriptLine, ScriptMoves, WorldSpell } from '../../../shared/world';
import { gatesOf } from './stepGates';
import {
  blockRun,
  linesRun,
  stepsRun,
  untilUnrun,
  type TbStep,
  type TbUse,
  type Textblock
} from './textblock';

/** How far a chain of casts and blocks is followed before it is called unread. */
export const SCRIPT_DEPTH = 8;

type Blocks = ReadonlyMap<number, Pick<Textblock, 'lines' | 'linkTo'>>;
export type SpellAbilities = ReadonlyArray<readonly [number, number]>;
/** A spell as its scripts are read: its ability pairs, and `MinBase..MaxBase`. */
export interface SpellScriptRow {
  abilities: SpellAbilities;
  power?: readonly [number, number];
}
type Abilities = (spell: number) => SpellScriptRow | undefined;

/** Whether a spell's own columns move whoever it lands on (`TeleportRoom`, `TeleportMap`). */
export function castMoves(abilities: SpellAbilities): boolean {
  return abilities.some(
    ([ability]) => ability === HAZARD_ABILITY.teleportRoom || ability === HAZARD_ABILITY.teleportMap
  );
}

/**
 * The rows one ability column names: its value, or for 0 the spell's own
 * roll, one of `MinBase..MaxBase` at random (`inMainValue`, `Spell.cs:1551`
 * for a summons and `:1637` for a script); none where the spell has no power.
 */
export function columnRows(value: number, power: readonly [number, number] | undefined): number[] {
  if (value > 0) return [value];
  const [low, high] = power ?? [0, 0];
  if (low <= 0 || high < low) return [];
  return Array.from({ length: high - low + 1 }, (_, index) => low + index);
}

/**
 * The text blocks a spell runs: every `TextBlock` column (`Spell.cs:1600`
 * runs each), as the blocks it may run, one taken at random.
 */
export function scriptsOf(spell: SpellScriptRow): number[][] {
  return spell.abilities.flatMap(([ability, value]) => {
    if (ability !== HAZARD_ABILITY.textBlock) return [];
    const rows = columnRows(value, spell.power);
    return rows.length > 0 ? [rows] : [];
  });
}

/**
 * The script an exit runs on whoever passes, from one spell of its chain: a
 * cast exit's post-spell (`CastExit.cs:36`, after the step; its pre-spell runs
 * before) or a spell trap's own.
 */
export function scriptAfter(
  requirement: Pick<Requirement, 'castPost' | 'spellId'>,
  id: number,
  spell: Pick<WorldSpell, 'script'>
): { script?: readonly ScriptLine[] } {
  const after = requirement.castPost ?? requirement.spellId;
  return id === after && spell.script !== undefined ? { script: spell.script } : {};
}

/**
 * A spell's script as its lines in order, or null for a spell whose script
 * cannot move anybody, or that runs none.
 */
export function scriptLines(
  spell: number,
  abilities: Abilities,
  blocks: Blocks
): ScriptLine[] | null {
  const scripts = scriptsOf(abilities(spell) ?? { abilities: [] }).flat();
  const block = scripts.length === 1 ? blocks.get(scripts[0]!) : undefined;
  if (block === undefined) {
    // Several scripts, run one after another or one of them at random, each
    // with its own lines: whether the character stays is not one ordered
    // list, so a spell where any moves is read as unread.
    const moves = scripts.map((id) => blockMoves(id, 'steps', abilities, blocks, 0));
    return moves.some((moved) => moved !== false) ? [{ gates: [], moves: 'unread' }] : null;
  }
  const lines = linesRun(block, 'steps').map((line): ScriptLine => {
    const steps = untilUnrun(stepsRun(line, 'steps'));
    for (const [index, step] of steps.entries()) {
      const moves = stepMoves(step, abilities, blocks, 0);
      if (moves !== false) return { gates: gatesOf(steps.slice(0, index)), moves };
    }
    return { gates: gatesOf(steps), moves: false };
  });
  return lines.some((line) => line.moves !== false) ? lines : null;
}

/** Whether one step moves whoever runs it; `'unread'` where the chain cannot be followed. */
function stepMoves(step: TbStep, abilities: Abilities, blocks: Blocks, depth: number): ScriptMoves {
  if (depth > SCRIPT_DEPTH) return 'unread';
  if (step.verb === 'teleport') return true;
  if (step.verb === 'cast') return spellMoves(step.spell, abilities, blocks, depth + 1);
  const run = blockRun(step);
  if (run === null) return false;
  const [id, use] = run;
  if (use !== 'shown') return blockMoves(id, use, abilities, blocks, depth + 1);
  // Showing a block runs what it links to (`TextBlock.Display`).
  const linked = blocks.get(id)?.linkTo ?? null;
  return linked === null || linked <= 0
    ? false
    : blockMoves(linked, 'steps', abilities, blocks, depth + 1);
}

/** Whether a block can move whoever runs it: a line that may is a block that does. */
function blockMoves(
  id: number,
  use: Exclude<TbUse, 'shown'>,
  abilities: Abilities,
  blocks: Blocks,
  depth: number
): ScriptMoves {
  const block = blocks.get(id);
  if (block === undefined) return 'unread';
  let unread = false;
  for (const line of linesRun(block, use)) {
    for (const step of untilUnrun(stepsRun(line, use))) {
      const moves = stepMoves(step, abilities, blocks, depth);
      if (moves === true) return true;
      if (moves === 'unread') unread = true;
    }
  }
  return unread ? 'unread' : false;
}

function spellMoves(
  spell: number,
  abilities: Abilities,
  blocks: Blocks,
  depth: number
): ScriptMoves {
  const row = abilities(spell);
  if (row === undefined) return 'unread';
  if (castMoves(row.abilities)) return true;
  let unread = false;
  for (const script of scriptsOf(row).flat()) {
    const moves = blockMoves(script, 'steps', abilities, blocks, depth);
    if (moves === true) return true;
    if (moves === 'unread') unread = true;
  }
  return unread ? 'unread' : false;
}
