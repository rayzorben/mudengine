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

export type Blocks = ReadonlyMap<number, Pick<Textblock, 'lines' | 'linkTo'>>;
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

/**
 * What a walk over a spell's script looks for: what a spell's own columns or a
 * step do outright, and which casts land on whoever runs the script and so are
 * followed. One walk, so the server's order of running a block is read once.
 */
export interface ScriptProbe<R extends SpellScriptRow> {
  own(row: R): boolean;
  step(step: TbStep): boolean;
  follows(row: R | undefined): boolean;
}

/** A move: a teleport step, or a spell whose columns teleport, cast at anyone. */
const MOVES: ScriptProbe<SpellScriptRow> = {
  own: (row) => castMoves(row.abilities),
  step: (step) => step.verb === 'teleport',
  follows: () => true
};

/** Whether one step moves whoever runs it; `'unread'` where the chain cannot be followed. */
function stepMoves(step: TbStep, abilities: Abilities, blocks: Blocks, depth: number): ScriptMoves {
  return stepDoes(step, MOVES, abilities, blocks, depth);
}

/** Whether a block can move whoever runs it: a line that may is a block that does. */
function blockMoves(
  id: number,
  use: Exclude<TbUse, 'shown'>,
  abilities: Abilities,
  blocks: Blocks,
  depth: number
): ScriptMoves {
  return blockDoes(id, use, MOVES, abilities, blocks, depth);
}

/**
 * Whether a spell, by its own columns or a step its scripts reach, does what
 * the probe looks for; `'unread'` where the chain cannot be followed.
 */
export function spellDoes<R extends SpellScriptRow>(
  spell: number,
  probe: ScriptProbe<R>,
  rows: (spell: number) => R | undefined,
  blocks: Blocks,
  depth = 0
): ScriptMoves {
  const row = rows(spell);
  if (row === undefined) return 'unread';
  if (probe.own(row)) return true;
  let unread = false;
  for (const script of scriptsOf(row).flat()) {
    const does = blockDoes(script, 'steps', probe, rows, blocks, depth);
    if (does === true) return true;
    if (does === 'unread') unread = true;
  }
  return unread ? 'unread' : false;
}

function stepDoes<R extends SpellScriptRow>(
  step: TbStep,
  probe: ScriptProbe<R>,
  rows: (spell: number) => R | undefined,
  blocks: Blocks,
  depth: number
): ScriptMoves {
  if (depth > SCRIPT_DEPTH) return 'unread';
  if (probe.step(step)) return true;
  if (step.verb === 'cast') {
    return probe.follows(rows(step.spell))
      ? spellDoes(step.spell, probe, rows, blocks, depth + 1)
      : false;
  }
  const run = blockRun(step);
  if (run === null) return false;
  const [id, use] = run;
  if (use !== 'shown') return blockDoes(id, use, probe, rows, blocks, depth + 1);
  // Showing a block runs what it links to (`TextBlock.Display`).
  const linked = blocks.get(id)?.linkTo ?? null;
  return linked === null || linked <= 0
    ? false
    : blockDoes(linked, 'steps', probe, rows, blocks, depth + 1);
}

function blockDoes<R extends SpellScriptRow>(
  id: number,
  use: Exclude<TbUse, 'shown'>,
  probe: ScriptProbe<R>,
  rows: (spell: number) => R | undefined,
  blocks: Blocks,
  depth: number
): ScriptMoves {
  const block = blocks.get(id);
  if (block === undefined) return 'unread';
  let unread = false;
  for (const line of linesRun(block, use)) {
    for (const step of untilUnrun(stepsRun(line, use))) {
      const does = stepDoes(step, probe, rows, blocks, depth);
      if (does === true) return true;
      if (does === 'unread') unread = true;
    }
  }
  return unread ? 'unread' : false;
}
