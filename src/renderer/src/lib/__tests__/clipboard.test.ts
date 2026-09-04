import { describe, expect, it } from 'vitest';

import { clipboardIntent, type ClipboardKey } from '../clipboard';

const key = (over: Partial<ClipboardKey>): ClipboardKey => ({
  type: 'keydown',
  key: 'a',
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...over
});

describe('what a keystroke in the terminal means for the clipboard', () => {
  it('copies on Ctrl C when something is selected', () => {
    expect(clipboardIntent(key({ key: 'c', ctrlKey: true }), true)).toBe('copy');
  });

  /*
   * The one that would be a regression rather than a missing feature. `Ctrl C`
   * is a control character the realm defines, and a client that swallowed it
   * to copy nothing would have taken it away.
   */
  it('leaves Ctrl C alone when nothing is selected, so the interrupt still goes', () => {
    expect(clipboardIntent(key({ key: 'c', ctrlKey: true }), false)).toBeNull();
  });

  it('takes Cmd C the same way, so one build serves both platforms', () => {
    expect(clipboardIntent(key({ key: 'c', metaKey: true }), true)).toBe('copy');
  });

  it('copies on Ctrl Shift C, which is what a terminal user reaches for', () => {
    expect(clipboardIntent(key({ key: 'C', ctrlKey: true, shiftKey: true }), true)).toBe('copy');
  });

  it('pastes on Ctrl V and Cmd V, selection or no selection', () => {
    expect(clipboardIntent(key({ key: 'v', ctrlKey: true }), false)).toBe('paste');
    expect(clipboardIntent(key({ key: 'v', metaKey: true }), true)).toBe('paste');
  });

  it('honours the X11 pair: Shift Insert pastes, Ctrl Insert copies', () => {
    expect(clipboardIntent(key({ key: 'Insert', shiftKey: true }), false)).toBe('paste');
    expect(clipboardIntent(key({ key: 'Insert', ctrlKey: true }), true)).toBe('copy');
    expect(clipboardIntent(key({ key: 'Insert', ctrlKey: true }), false)).toBeNull();
  });

  /*
   * The handler xterm calls is given keyup and keypress as well, and each of
   * the three carries the same modifiers. Acting on all of them would copy
   * three times and paste the clipboard twice.
   */
  it('acts on the press and on nothing else', () => {
    for (const type of ['keyup', 'keypress']) {
      expect(clipboardIntent(key({ type, key: 'c', ctrlKey: true }), true)).toBeNull();
      expect(clipboardIntent(key({ type, key: 'v', ctrlKey: true }), false)).toBeNull();
    }
  });

  it('stands down when Alt is held, which belongs to the game', () => {
    expect(clipboardIntent(key({ key: 'c', ctrlKey: true, altKey: true }), true)).toBeNull();
    expect(clipboardIntent(key({ key: 'v', ctrlKey: true, altKey: true }), false)).toBeNull();
  });

  it('ignores an unmodified letter, which is a player typing', () => {
    expect(clipboardIntent(key({ key: 'c' }), true)).toBeNull();
    expect(clipboardIntent(key({ key: 'v' }), true)).toBeNull();
  });
});
