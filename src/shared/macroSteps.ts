/**
 * A macro read into what each of its lines does (todo 134). One rule: a bare
 * line goes to the server, a `{…}` is the client's. A value sits inside a
 * line (`a {mob}`); a macro (`{f2}`, `{doit}`) or an action (`{goto 1/297}`,
 * `{sneak}`) is a line on its own, and written inside one the line is
 * refused. A call is flattened when the macro starts, so a macro that reaches
 * itself is refused before anything goes out. Pure: main runs the steps, the
 * settings page and the load notice say which entries are refused.
 * `mudengine-automation` › *A macro is a list of steps*.
 */

import { asTyped, clientCommandOf, type ClientCommand } from './clientCommands';
import {
  MACRO_ACTIONS,
  isMacroValue,
  macroLines,
  parseMacro,
  placeholdersIn,
  type MacroAction
} from './macro';
import type { UiLookup } from './i18n';
import { channelPrefix } from './talk';

/** What one line of a macro does. Closed; `MACRO_STEP_KINDS` is its list. */
export type MacroStep =
  /** Sent to the server, `times` over, each `fills` value filled in at its turn. */
  | { kind: 'send'; command: string; times: number; fills: readonly string[] }
  /** Run by the client at its turn (`get all`). */
  | { kind: 'client'; command: ClientCommand; words: string }
  /** Another macro's lines, run here: a key by its name, or an alias word. */
  | { kind: 'call'; name: string }
  /** Go to a room, by what `@goto` reads; the next line waits for arrival. */
  | { kind: 'goto'; request: string }
  /** Be sneaking: `sn` unless already, and the next line waits for the answer. */
  | { kind: 'sneak' };

export const MACRO_STEP_KINDS = [
  'send',
  'client',
  'call',
  'goto',
  'sneak'
] as const satisfies readonly MacroStep['kind'][];

/** Why a macro is not run. Closed; `macroFaultText` in `session/macros.ts` words each. */
export type MacroFault =
  /** A macro or an action, or a name nothing knows, written inside a line. */
  | { kind: 'inside'; name: string }
  /** `{goto}` with no room. */
  | { kind: 'noRoom' }
  /** A call to a macro this character does not have. */
  | { kind: 'missing'; name: string }
  /** A macro that reaches itself, by the names it went through. */
  | { kind: 'loops'; chain: readonly string[] }
  /** More commands than one macro may send. */
  | { kind: 'tooMany'; limit: number };

export type MacroRead = { steps: MacroStep[] } | { fault: MacroFault };

/** A line that is a brace and nothing else. */
const WHOLE = /^\{\s*([^{}]*?)\s*\}$/;

/** What `{inner}` alone on a line is. */
function braced(inner: string, times: number, command: string): MacroStep | MacroFault {
  const [first = '', ...rest] = inner.split(/\s+/);
  const action = MACRO_ACTIONS.find((name) => name === first.toLowerCase());
  if (action !== undefined) return actionStep(action, rest.join(' '));
  if (isMacroValue(inner)) return { kind: 'send', command, times, fills: [inner] };
  if (rest.length > 0 || inner.length === 0) return { kind: 'inside', name: inner };
  return { kind: 'call', name: inner };
}

function actionStep(action: MacroAction, request: string): MacroStep | MacroFault {
  switch (action) {
    case 'goto':
      return request.length > 0 ? { kind: 'goto', request } : { kind: 'noRoom' };
    case 'sneak':
      return { kind: 'sneak' };
    default: {
      const never: never = action;
      return never;
    }
  }
}

/** One command of a macro, read. */
function stepOf(command: string, times: number): MacroStep | MacroFault {
  const sent = asTyped(command);
  if (sent !== null) return { kind: 'send', command: sent, times, fills: [] };
  const whole = WHOLE.exec(command);
  if (whole !== null) return braced(whole[1]!, times, command);
  const names = placeholdersIn(command);
  const stray = names.find((name) => !isMacroValue(name));
  if (stray !== undefined) return { kind: 'inside', name: stray };
  // A brace holding a space (`{goto 1/297}`) is an action written inside a line.
  const spaced = /\{([^{}]*\s[^{}]*)\}/.exec(command);
  if (spaced !== null) return { kind: 'inside', name: spaced[1]!.trim() };
  const client = clientCommandOf(command);
  if (client !== null) return { kind: 'client', command: client, words: command };
  return { kind: 'send', command, times, fills: names };
}

function isFault(read: MacroStep | MacroFault): read is MacroFault {
  return !(MACRO_STEP_KINDS as readonly string[]).includes(read.kind);
}

/** A macro's text (a list's lines, or a `;` line) read into its steps, or why not. */
export function readMacro(text: string): MacroRead {
  const steps: MacroStep[] = [];
  for (const { command, times } of macroLines(text)) {
    const read = stepOf(command, times);
    if (isFault(read)) return { fault: read };
    // Counted, as MegaMUD counts: `2get all` gets twice. A send keeps its count as `times`.
    const each = read.kind === 'send' ? 1 : times;
    for (let i = 0; i < each; i += 1) steps.push(read);
  }
  return { steps };
}

/** Why a macro's text cannot be run whatever else is set, or null. */
export function lineFault(text: string): MacroFault | null {
  const read = readMacro(text);
  return 'fault' in read ? read.fault : null;
}

/** Whether main runs one command itself: a client command or anything in braces, never speech. */
export function runsItself(line: string): boolean {
  const whole = line.trim();
  if (channelPrefix(whole) !== null) return false;
  return clientCommandOf(whole) !== null || /\{[^{}]+\}/.test(whole);
}

/**
 * A typed line read into its steps, or null where it goes out as typed: a
 * line of several (`parseMacro`), a list, a client command, or a line with
 * braces. Speech on a channel and a line marked `AS_TYPED` are never any of
 * them.
 */
export function typedSteps(line: string): MacroRead | null {
  if (asTyped(line) !== null) return null;
  if (!line.includes('\n') && parseMacro(line) === null && !runsItself(line)) return null;
  return readMacro(line);
}

/** The other macros a step list may call: a key by its name, an alias by its word. */
export interface MacroBook {
  /** The macro `name` calls, by the name it is filed under, or null. */
  find(name: string): { id: string; text: string } | null;
  /** Every macro, by the name it is filed under. */
  entries(): ReadonlyArray<{ id: string; text: string }>;
}

/** How many commands a step puts on the wire: a `{sneak}` may send `sn`. */
function commandsOf(step: MacroStep): number {
  return step.kind === 'send' ? step.times : 1;
}

/**
 * The steps with every call replaced by the lines it names, or the fault: a
 * name the book does not have, a macro reaching itself, or more commands in
 * all than `limit`, found as soon as the count passes it, so a book of macros
 * that each call another twice costs no more than `limit` steps to refuse.
 * `from` is the name the steps are filed under, if any.
 */
export function expandMacros(
  steps: readonly MacroStep[],
  book: MacroBook,
  limit: number,
  from: string | null = null
): MacroRead {
  const out: MacroStep[] = [];
  let count = 0;
  const walk = (list: readonly MacroStep[], chain: readonly string[]): MacroFault | null => {
    for (const step of list) {
      if (step.kind !== 'call') {
        count += commandsOf(step);
        if (count > limit) return { kind: 'tooMany', limit };
        out.push(step);
        continue;
      }
      const called = book.find(step.name);
      if (called === null) return { kind: 'missing', name: step.name };
      if (chain.includes(called.id)) return { kind: 'loops', chain: [...chain, called.id] };
      const read = readMacro(called.text);
      if ('fault' in read) return read.fault;
      const fault = walk(read.steps, [...chain, called.id]);
      if (fault !== null) return fault;
    }
    return null;
  };
  const fault = walk(steps, from === null ? [] : [from]);
  return fault === null ? { steps: out } : { fault };
}

/**
 * The names of every macro in the book that reaches itself, through any
 * others: the strongly connected parts of the graph of calls (Tarjan), each
 * macro read once, so the cost is the number of macros and calls however
 * often one is called.
 */
export function loopingMacros(book: MacroBook): ReadonlySet<string> {
  const calls = new Map<string, string[]>();
  for (const { id, text } of book.entries()) {
    const read = readMacro(text);
    const steps = 'fault' in read ? [] : read.steps;
    const called = steps.flatMap((step) =>
      step.kind === 'call' ? [book.find(step.name)?.id ?? null] : []
    );
    calls.set(
      id,
      called.filter((name): name is string => name !== null)
    );
  }
  const looping = new Set<string>();
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  let next = 0;
  const visit = (id: string): void => {
    index.set(id, next);
    low.set(id, next);
    next += 1;
    stack.push(id);
    onStack.add(id);
    for (const to of calls.get(id) ?? []) {
      if (!index.has(to)) {
        visit(to);
        low.set(id, Math.min(low.get(id)!, low.get(to)!));
      } else if (onStack.has(to)) {
        low.set(id, Math.min(low.get(id)!, index.get(to)!));
      }
    }
    if (low.get(id) !== index.get(id)) return;
    const part: string[] = [];
    let popped: string | undefined;
    do {
      popped = stack.pop()!;
      onStack.delete(popped);
      part.push(popped);
    } while (popped !== id);
    // One macro alone loops only by calling itself.
    if (part.length > 1 || (calls.get(id) ?? []).includes(id)) {
      for (const name of part) looping.add(name);
    }
  };
  for (const id of calls.keys()) if (!index.has(id)) visit(id);
  return looping;
}

/** Why a key or an alias does not load, the same for both. */
export type MacroRefusal =
  /** Neither a line nor a list of lines. */
  | 'shape'
  /** A `{…}` that is no value inside a line: a macro, an action or a misspelling. */
  | 'line'
  /** It reaches itself through the macros it calls. */
  | 'loops';

/** Why a key or an alias does not load, in words, for the page and the load notice. */
export function macroRefusalText(refusal: MacroRefusal, t: UiLookup): string {
  switch (refusal) {
    case 'shape':
      return t('settings.macros.refusal.shape');
    case 'line':
      return t('settings.macros.refusal.line');
    case 'loops':
      return t('settings.macros.refusal.loops');
    default: {
      const never: never = refusal;
      return never;
    }
  }
}
