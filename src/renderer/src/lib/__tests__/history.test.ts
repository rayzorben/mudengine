import { describe, expect, it } from 'vitest';

import { begin, canRedo, canUndo, historyIntent, record, redo, replace, undo } from '../history';
import type { HistoryKey, HistoryTarget } from '../history';

const same = (a: string, b: string): boolean => a === b;
const of = (...values: string[]): ReturnType<typeof begin<string>> =>
  values.slice(1).reduce((history, value) => record(history, value, same), begin(values[0]!));

describe('stepping back and forward', () => {
  it('has nowhere to go to begin with', () => {
    const history = begin('a');
    expect(canUndo(history)).toBe(false);
    expect(canRedo(history)).toBe(false);
    expect(undo(history)).toBe(history);
    expect(redo(history)).toBe(history);
  });

  it('walks back through the edits and forward again', () => {
    const three = of('a', 'b', 'c');
    expect(three.present).toBe('c');
    expect(undo(three).present).toBe('b');
    expect(undo(undo(three)).present).toBe('a');
    expect(redo(undo(three)).present).toBe('c');
  });

  /*
   * A form re-rendering with the same contents must not fill the history with
   * nothing, or an undo would appear to do nothing however many times it was
   * pressed.
   */
  it('does not record a value that says the same thing', () => {
    const history = record(of('a'), 'a', same);
    expect(canUndo(history)).toBe(false);
  });

  /* The ordinary undo contract: editing after undoing abandons what was
     undone. Keeping it would make redo mean something different depending on
     how you got there. */
  it('drops the future when something new is done', () => {
    const stepped = undo(of('a', 'b', 'c'));
    expect(canRedo(stepped)).toBe(true);
    expect(canRedo(record(stepped, 'd', same))).toBe(false);
  });

  /*
   * A value that arrived from somewhere other than an edit -- a reload from
   * disk after a save. Recording it would put a step in the history nobody
   * took, and undoing that would look like the client changing its mind.
   */
  it('replaces the present without making it a step', () => {
    const history = replace(of('a', 'b'), 'b-as-written');
    expect(history.present).toBe('b-as-written');
    expect(history.past).toEqual(['a']);
    expect(undo(history).present).toBe('a');
  });

  /* Bounded, so a long session cannot grow without end. */
  it('forgets the oldest edits rather than growing for ever', () => {
    let history = begin('0');
    for (let n = 1; n <= 80; n += 1) history = record(history, String(n), same);
    expect(history.past.length).toBeLessThanOrEqual(50);
    expect(history.past[0]).not.toBe('0');
  });
});

/** A stand-in for what a keystroke landed on. See `HistoryTarget`. */
const on = (tagName: string, type?: string): HistoryTarget => ({ tagName, type });

const chord = (key: string, over: Partial<HistoryKey> = {}): HistoryKey => ({
  key,
  ctrlKey: true,
  metaKey: false,
  shiftKey: false,
  ...over
});

describe('what a keystroke means', () => {
  it('reads both undo chords and all three redo ones', () => {
    expect(historyIntent(chord('z'), on('button'))).toBe('undo');
    expect(historyIntent(chord('z', { ctrlKey: false, metaKey: true }), on('button'))).toBe('undo');
    expect(historyIntent(chord('z', { shiftKey: true }), on('button'))).toBe('redo');
    expect(
      historyIntent(chord('z', { ctrlKey: false, metaKey: true, shiftKey: true }), on('button'))
    ).toBe('redo');
    expect(historyIntent(chord('y'), on('button'))).toBe('redo');
  });

  it('is nothing without the modifier', () => {
    expect(historyIntent(chord('z', { ctrlKey: false }), on('button'))).toBeNull();
  });

  /*
   * The rule that makes this usable at all. `Ctrl Z` in a text field is the
   * field's own undo, a character at a time, and taking it away to step a whole
   * form back would be the worse trade in the place people spend all their
   * time. The buttons stay reachable.
   */
  it('stands down while the caret is in something that types', () => {
    expect(historyIntent(chord('z'), on('input', 'text'))).toBeNull();
    expect(historyIntent(chord('z'), on('input', 'password'))).toBeNull();
    expect(historyIntent(chord('z'), on('textarea'))).toBeNull();
  });

  /* A checkbox has no text to undo, so the chord belongs to the form there. */
  it('claims it over a control with nothing to type into', () => {
    expect(historyIntent(chord('z'), on('input', 'checkbox'))).toBe('undo');
    expect(historyIntent(chord('z'), on('select'))).toBe('undo');
  });
});
