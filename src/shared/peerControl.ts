/**
 * Remote control across two builds (todo 20261031-1156-01, the user's answer
 * of 2026-11-03): a player who shares a character at `control` lets the other
 * player watch its terminal text and send it one of a fixed list of actions.
 * The settings, loops and cards are not reached: an action is one of
 * `CONTROL_ACTIONS`, read field by field, and one this build does not know is
 * refused with its name, never fatal. The two switches are the toolbar's own
 * presses (the master switch is the one the toolbar keeps in the file, as
 * the toolbar does). Nothing here can name the account or a share. See `mudengine-session` › *Peers*.
 */
import { asDirection, type Direction } from './world';
import { isRecord, memberOf } from './values';

/** The action's own version, raised when a field changes meaning. A new action does not raise it. */
export const CONTROL_VERSION = 1;

/** The switches an action may flip: the master switch and auto-combat, as the toolbar has them. */
export type ControlSwitch = 'automation' | 'combat';
export const CONTROL_SWITCHES: readonly ControlSwitch[] = ['automation', 'combat'];

/**
 * What a controller may ask of the character. `line` is a line typed into
 * its terminal (a spell, a use, a say), `move` a direction, `rest` the rest
 * command, `stop` the route or loop's stop, `play` the named loop of the
 * sharer's own (or whatever was stopped), `switch` one of `CONTROL_SWITCHES`.
 */
export type ControlAction =
  | { readonly a: 'line'; readonly text: string }
  | { readonly a: 'move'; readonly dir: Direction }
  | { readonly a: 'rest' }
  | { readonly a: 'stop' }
  | { readonly a: 'play'; readonly loop: string | null; readonly confirmed: number | null }
  | { readonly a: 'switch'; readonly name: ControlSwitch; readonly on: boolean };

export type ControlActionName = ControlAction['a'];
export const CONTROL_ACTIONS: readonly ControlActionName[] = [
  'line',
  'move',
  'rest',
  'stop',
  'play',
  'switch'
];

/** The longest line or loop name an action carries; the sharer reads a line again at its own cap. */
export const MOST_CONTROL_TEXT = 1000;

/**
 * An action off the wire: the action, or why it does not read. `unknown` is
 * an action another build has and this one lacks, by its name; `malformed` a
 * known action with a field missing or of the wrong type. A field this build
 * does not know is ignored.
 */
export type ReadAction =
  | { readonly ok: true; readonly action: ControlAction }
  | { readonly ok: false; readonly why: 'unknown'; readonly name: string }
  | { readonly ok: false; readonly why: 'malformed' | 'version' };

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 && value.length <= MOST_CONTROL_TEXT ? value : null;

export function asControlAction(value: unknown): ReadAction {
  if (!isRecord(value)) return { ok: false, why: 'malformed' };
  const v = value['v'];
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1)
    return { ok: false, why: 'malformed' };
  if (v > CONTROL_VERSION) return { ok: false, why: 'version' };
  const a = value['a'];
  const name = memberOf(a, CONTROL_ACTIONS);
  if (name === null) {
    return typeof a === 'string'
      ? { ok: false, why: 'unknown', name: a.slice(0, 40) }
      : { ok: false, why: 'malformed' };
  }
  const action = readAction(name, value);
  return action === null ? { ok: false, why: 'malformed' } : { ok: true, action };
}

function readAction(
  name: ControlActionName,
  value: Readonly<Record<string, unknown>>
): ControlAction | null {
  switch (name) {
    case 'line': {
      const line = text(value['text']);
      return line === null ? null : { a: name, text: line };
    }
    case 'move': {
      const dir = typeof value['dir'] === 'string' ? asDirection(value['dir']) : null;
      return dir === null ? null : { a: name, dir };
    }
    case 'rest':
    case 'stop':
      return { a: name };
    case 'play': {
      const loop = value['loop'] ?? null;
      const confirmed = value['confirmed'] ?? null;
      if (loop !== null && text(loop) === null) return null;
      if (confirmed !== null && (typeof confirmed !== 'number' || !Number.isFinite(confirmed))) {
        return null;
      }
      return { a: name, loop: loop as string | null, confirmed: confirmed as number | null };
    }
    case 'switch': {
      const which = memberOf(value['name'], CONTROL_SWITCHES);
      const on = value['on'];
      return which === null || typeof on !== 'boolean' ? null : { a: name, name: which, on };
    }
    default: {
      const never: never = name;
      return never;
    }
  }
}

/** An action as it goes on the wire, with its version. */
export function actionFrame(action: ControlAction): Record<string, unknown> {
  return { v: CONTROL_VERSION, ...action };
}

/**
 * What became of an action, in the sharer's words. `confirm` is play asking
 * back, as the toolbar's play does: the route has grown by `steps` since it
 * stopped, and sending play again with `confirmed: steps` walks it.
 */
export type ControlAnswer =
  | { readonly r: 'done' }
  | { readonly r: 'refused'; readonly why: string }
  | { readonly r: 'confirm'; readonly name: string; readonly steps: number };

export type ControlAnswerKind = ControlAnswer['r'];
export const CONTROL_ANSWERS: readonly ControlAnswerKind[] = ['done', 'refused', 'confirm'];

/** The longest refusal a sharer's answer carries. */
const MOST_WHY = 400;

/**
 * An answer off the wire, read field by field: null for one this build does
 * not read, which the controller reports as such rather than guessing.
 */
export function asControlAnswer(value: unknown): ControlAnswer | null {
  if (!isRecord(value)) return null;
  const r = memberOf(value['r'], CONTROL_ANSWERS);
  if (r === null) return null;
  switch (r) {
    case 'done':
      return { r };
    case 'refused': {
      const why = value['why'];
      return typeof why === 'string' && why.length <= MOST_WHY ? { r, why } : null;
    }
    case 'confirm': {
      const name = text(value['name']);
      const steps = value['steps'];
      return name !== null && typeof steps === 'number' && Number.isFinite(steps)
        ? { r, name, steps }
        : null;
    }
    default: {
      const never: never = r;
      return never;
    }
  }
}
