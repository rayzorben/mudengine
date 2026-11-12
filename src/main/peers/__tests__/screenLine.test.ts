import { describe, expect, it } from 'vitest';

import { screenLine } from '../screenLine';

/*
 * Todo 20261031-1156-01: a line another player types into a character it
 * controls is sent unless it logs the character off, deletes it, or passes an
 * `@` command on.
 */
function reports() {
  const notices: string[] = [];
  return {
    notices,
    events: { notice: (message: string) => notices.push(message), decided: () => undefined }
  };
}

describe('a line typed by remote control', () => {
  it('sends an ordinary command', () => {
    const { events, notices } = reports();
    expect(screenLine('cast mihe Soul', 'Soul', events)).toBeNull();
    expect(screenLine('exp', 'Soul', events)).toBeNull();
    expect(notices).toEqual([]);
  });

  it('refuses a line that would log the character off or delete it', () => {
    const { events } = reports();
    for (const text of ['x', 'quit', 'qui', 'suicide', 'reroll', 'Exit now']) {
      expect(screenLine(text, 'Soul', events), text).toBe(
        `"${text}" logs the character off or deletes it, so it is not sent by remote control`
      );
    }
  });

  it('refuses a line that would pass an @ command on, and says so', () => {
    const { events, notices } = reports();
    expect(screenLine('/Rand @do drop all', 'Soul', events)).not.toBeNull();
    expect(notices).toHaveLength(1);
  });
});
