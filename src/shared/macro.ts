/**
 * A talk-box line that stands for several commands (todo 04).
 *
 * `;` separates commands, `6s` is `s` six times, and `2d,6s,3u` is three of
 * those in one piece. A comma only joins repeats: a piece whose every
 * comma-separated part is `<count><command>` is split, and anything else —
 * `say hi, all` — is one command with its comma. A line that opens on a
 * channel is speech and is never split. Pure, so the box can decide
 * with it which path a line takes and main can parse the same line again
 * rather than trust a list off the wire. `mudengine-ui` › *The Talk card*.
 */

import { channelPrefix } from './talk';

/** One command and how many times it goes out. */
export interface MacroStep {
  command: string;
  times: number;
}

/** A count, then a command that starts with a letter: `6s`, `2ne`, `3get torch`. */
const REPEAT = /^(\d+)([a-z].*)$/i;

function repeatOf(part: string): MacroStep | null {
  const found = REPEAT.exec(part);
  if (found === null) return null;
  const times = Number(found[1]);
  if (!Number.isSafeInteger(times) || times < 1) return null;
  return { command: found[2]!.trim(), times };
}

/**
 * The commands a line stands for, in order, or null where it is one command
 * with no directive in it, which the box sends exactly as typed.
 */
export function parseMacro(line: string): MacroStep[] | null {
  // Speech carries `;)`, and `gos gg ;)` split would say `)` in the room.
  if (channelPrefix(line.trimStart()) !== null) return null;
  let directive = line.includes(';');
  const steps: MacroStep[] = [];
  for (const piece of line.split(';')) {
    const trimmed = piece.trim();
    if (trimmed.length === 0) continue;
    const repeats = trimmed.split(',').map((part) => repeatOf(part.trim()));
    if (repeats.every((step): step is MacroStep => step !== null)) {
      directive = true;
      steps.push(...repeats);
    } else {
      steps.push({ command: trimmed, times: 1 });
    }
  }
  return directive && steps.length > 0 ? steps : null;
}

/** How many commands the steps put on the wire. */
export function macroLength(steps: readonly MacroStep[]): number {
  return steps.reduce((sum, step) => sum + step.times, 0);
}
