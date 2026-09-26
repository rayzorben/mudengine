import { describe, expect, it } from 'vitest';
import { Terminal } from '@xterm/xterm';

import { asksAColour, silenceQueries } from '../terminalQueries';

/* Todo 832: the terminal types nothing of its own into the game. */
describe('the terminal answers no queries', () => {
  /** What xterm sends to the game after `bytes`, and then after a focus change. */
  const answers = (bytes: string, silenced: boolean): Promise<string[]> =>
    new Promise((resolve) => {
      const term = new Terminal({ allowProposedApi: true });
      if (silenced) silenceQueries(term);
      const out: string[] = [];
      term.onData((data) => out.push(data));
      term.write(bytes, () => {
        term.dispose();
        resolve(out);
      });
    });

  it.each([
    ['the cursor report', '\x1b[6n'],
    ['the status report', '\x1b[5n'],
    ['the private cursor report', '\x1b[?6n'],
    ['primary device attributes', '\x1b[c'],
    ['secondary device attributes', '\x1b[>c'],
    ['an ANSI mode', '\x1b[4$p'],
    ['a private mode', '\x1b[?25$p'],
    ['a setting', '\x1bP$qm\x1b\\'],
    ['focus reporting turned on', '\x1b[?1004h']
  ])('says nothing to %s', async (_name, bytes) => {
    // The positive control, per query: unsilenced, xterm answers this one.
    expect((await answers(bytes, false)).length).toBeGreaterThan(0);
    expect(await answers(bytes, true)).toEqual([]);
  });

  it('sets the rest of a private mode sequence that named a reporting mode', async () => {
    const term = new Terminal({ allowProposedApi: true });
    silenceQueries(term);
    await new Promise<void>((resolve) => term.write('\x1b[?7l\x1b[?1004;7h', resolve));
    await new Promise<void>((resolve) => term.write('', resolve));
    expect(term.modes.sendFocusMode).toBe(false);
    expect(term.modes.wraparoundMode).toBe(true);
    term.dispose();
  });

  it('tells a colour query from a colour set', () => {
    expect(asksAColour('?')).toBe(true);
    expect(asksAColour('1;?')).toBe(true);
    expect(asksAColour('rgb:00/00/00')).toBe(false);
    expect(asksAColour('1;#ffffff')).toBe(false);
  });

  it('still carries what the player types', () => {
    const term = new Terminal({ allowProposedApi: true });
    silenceQueries(term);
    const out: string[] = [];
    term.onData((data) => out.push(data));
    term.input('n');
    term.dispose();
    expect(out).toEqual(['n']);
  });
});
