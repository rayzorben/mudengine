/**
 * The route list's shape: which steps read the same and fold into one row.
 *
 * *Slum Street, Slum Street, Slum Street* is one row saying `×3` (todo 01,
 * 2026-09-10): a corridor of one name is the reader scrolling past the same
 * word, and the row that matters is the one where the name — or the chip
 * beside it — changes. Pure, so the folding can be asserted without a DOM.
 *
 * See `mudengine-ui` › *A trap is a shape, and the route list counts them at
 * its head*.
 */
import type { RouteStep } from '@shared/world';

/** A run of consecutive steps, `count` long from `start`. One is a plain step. */
export interface StepRun {
  start: number;
  count: number;
}

/**
 * What a step's row shows besides its command: the room and every chip. Two
 * steps with the same signature draw the same row, so they fold; a trap, a
 * lair figure or a different hazard share keeps its own line, because a chip
 * that folded into a neighbour's row is a chip the reader never sees.
 *
 * The figures are rounded exactly as the chips draw them, so what folds is
 * what would have read identically — never two rooms whose shares differ in
 * a digit the chip does not show.
 */
export function stepSignature(step: RouteStep): string {
  const gate = step.obstacle?.label ?? step.requirement?.kind ?? '';
  const hazard =
    step.hazardKind !== undefined
      ? step.hazardKind
      : step.hazard === undefined
        ? ''
        : step.hazard * 100 < 1
          ? '<1'
          : String(Math.round(step.hazard * 100));
  const lair =
    step.danger === undefined
      ? ''
      : step.deadly === true
        ? 'deadly'
        : String(Math.max(1, Math.round(step.danger * 100)));
  return [step.name, gate, hazard, lair].join('|');
}

/** Consecutive steps with one signature, as runs, in order. */
export function runsOf(signatures: readonly string[]): StepRun[] {
  const runs: StepRun[] = [];
  for (const [index, signature] of signatures.entries()) {
    const last = runs[runs.length - 1];
    if (last !== undefined && signatures[last.start] === signature) last.count += 1;
    else runs.push({ start: index, count: 1 });
  }
  return runs;
}

/**
 * The commands of a folded run, compactly: `s ×3` where they are all one
 * word, and the words in order where they are not (`n n e`).
 */
export function commandsOf(steps: readonly RouteStep[]): string {
  const words = steps.map((step) => step.command);
  if (words.length > 1 && words.every((word) => word === words[0])) {
    return `${words[0]} ×${words.length}`;
  }
  return words.join(' ');
}
