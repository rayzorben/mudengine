/**
 * Undo and redo, as a value rather than as a component's tangle of state.
 *
 * Pure and here because that is where the edge cases are: what an undo does at
 * the beginning, what a redo does after a new edit, and — the one that decides
 * whether the feature is usable at all — what counts as *an* edit. A form that
 * pushed a history entry per keystroke would make undo mean "delete one
 * letter", which is what the field's own undo already does and does better.
 *
 * So `record` takes a comparison and drops a value that says the same thing as
 * the one before it. What the caller passes for that is the whole design: a
 * settings form checkpoints on the *saved* shape, so one undo is one change
 * somebody would describe out loud — "put the threshold back" — rather than one
 * character.
 */

import { tuning } from './tuning';

export interface History<T> {
  /** Oldest first. The value before each edit. */
  past: readonly T[];
  present: T;
  /** Newest first: `future[0]` is what a redo returns to. */
  future: readonly T[];
}

export function begin<T>(present: T): History<T> {
  return { past: [], present, future: [] };
}

/**
 * Records an edit.
 *
 * A value equal to the present is not an edit — a form re-rendering with the
 * same contents must not fill the history with nothing, or an undo would
 * appear to do nothing however many times it was pressed.
 *
 * **The future is dropped**, which is the ordinary undo contract: editing after
 * undoing abandons what was undone. Keeping it would make redo mean something
 * different depending on how you got there.
 */
export function record<T>(
  history: History<T>,
  present: T,
  same: (a: T, b: T) => boolean
): History<T> {
  if (same(history.present, present)) return history;
  return {
    past: [...history.past, history.present].slice(-tuning().historyDepth),
    present,
    future: []
  };
}

/**
 * Replaces the present without recording it.
 *
 * For a value that arrived from somewhere other than an edit — a reload from
 * disk after a save, say. Recording those would put a step in the history that
 * nobody took, and undoing it would look like the client changing its mind.
 */
export function replace<T>(history: History<T>, present: T): History<T> {
  return { ...history, present };
}

export function canUndo<T>(history: History<T>): boolean {
  return history.past.length > 0;
}

export function canRedo<T>(history: History<T>): boolean {
  return history.future.length > 0;
}

export function undo<T>(history: History<T>): History<T> {
  const previous = history.past[history.past.length - 1];
  if (previous === undefined) return history;
  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future].slice(0, tuning().historyDepth)
  };
}

export function redo<T>(history: History<T>): History<T> {
  const next = history.future[0];
  if (next === undefined) return history;
  return {
    past: [...history.past, history.present].slice(-tuning().historyDepth),
    present: next,
    future: history.future.slice(1)
  };
}

/**
 * Whether a keystroke means undo, redo, or nothing.
 *
 * The chord differs by platform and the *redo* chord differs twice over:
 * `Cmd Shift Z` is the macOS answer, `Ctrl Y` the Windows one, and `Ctrl Shift
 * Z` is understood everywhere. All three are accepted rather than one being
 * chosen, because somebody arriving from another application presses the one
 * their hands know and a chord that silently does nothing reads as a feature
 * that is not there.
 *
 * **It declines while the caret is in a text field**, which is the one rule
 * that makes this usable at all: `Ctrl Z` in a field is the field's own undo,
 * it works a character at a time, and taking it away to step a whole form back
 * would be the worse trade in the place people spend all their time. The
 * buttons stay reachable, and a form-level undo is what they are for.
 */
export type HistoryIntent = 'undo' | 'redo' | null;

/** The chord, without the event object. */
export interface HistoryKey {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

/**
 * What the keystroke landed on, as much of it as this decision needs.
 *
 * A shape rather than an `Element`, like `clipboardIntent` takes: the decision
 * is then testable without a DOM, which is what the rest of `lib/` does and
 * what lets the edge cases below be checked at all.
 */
export interface HistoryTarget {
  tagName?: string | undefined;
  /** An `<input>`'s type. Absent for anything else. */
  type?: string | undefined;
  isContentEditable?: boolean | undefined;
}

export function historyIntent(event: HistoryKey, target: HistoryTarget | null): HistoryIntent {
  if (!event.ctrlKey && !event.metaKey) return null;
  if (typing(target)) return null;

  const key = event.key.toLowerCase();
  if (key === 'z') return event.shiftKey ? 'redo' : 'undo';
  // Windows' other redo. Never with Shift, which is nothing anywhere.
  if (key === 'y' && !event.shiftKey && event.ctrlKey) return 'redo';
  return null;
}

function typing(target: HistoryTarget | null): boolean {
  if (target === null) return false;
  if (target.isContentEditable === true) return true;
  const tag = (target.tagName ?? '').toUpperCase();
  if (tag === 'TEXTAREA') return true;
  if (tag !== 'INPUT') return false;
  // A checkbox has no text to undo, so the chord belongs to the form there.
  return target.type !== 'checkbox' && target.type !== 'radio';
}

/** The shape above, read off whatever a keystroke actually landed on. */
export function targetOf(node: EventTarget | null): HistoryTarget | null {
  if (node === null || !('tagName' in node)) return null;
  const element = node as HTMLElement & { type?: string };
  return {
    tagName: element.tagName,
    type: element.type,
    isContentEditable: element.isContentEditable
  };
}
