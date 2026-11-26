import { describe, expect, it } from 'vitest';

import { screenLine } from '../screenLine';

/*
 * Todo 20261031-1156-01: a line another player types into a character it
 * controls is sent unless it logs the character off or deletes it. One that
 * sends an `@` command on goes through (the user, 2026-11-25).
 */
describe('a line typed by remote control', () => {
  it('sends an ordinary command', () => {
    expect(screenLine('cast mihe Soul')).toBeNull();
    expect(screenLine('exp')).toBeNull();
  });

  it('refuses a line that would log the character off or delete it', () => {
    for (const text of ['x', 'quit', 'qui', 'suicide', 'reroll', 'Exit now']) {
      expect(screenLine(text), text).toBe(
        `"${text}" logs the character off or deletes it, so it is not sent by remote control`
      );
    }
  });

  it('sends a line that passes an @ command on', () => {
    for (const text of ['.@ok', '/Rand @do drop all', 'bg @party n']) {
      expect(screenLine(text), text).toBeNull();
    }
  });
});
