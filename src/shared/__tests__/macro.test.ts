import { describe, expect, it } from 'vitest';

import { macroLength, parseMacro } from '../macro';

describe('a talk-box line of several commands', () => {
  it('splits on semicolons, spacing and empty pieces ignored', () => {
    expect(parseMacro('spit;spit')).toEqual([
      { command: 'spit', times: 1 },
      { command: 'spit', times: 1 }
    ]);
    expect(parseMacro(' s ; recover corpse;;n; ')).toEqual([
      { command: 's', times: 1 },
      { command: 'recover corpse', times: 1 },
      { command: 'n', times: 1 }
    ]);
  });

  /* The todo's own line. */
  it('reads a count in front of a command, and commas between counted ones', () => {
    const steps = parseMacro('s;recover corpse;n;dive pool;2d,6s,3u');
    expect(steps).toEqual([
      { command: 's', times: 1 },
      { command: 'recover corpse', times: 1 },
      { command: 'n', times: 1 },
      { command: 'dive pool', times: 1 },
      { command: 'd', times: 2 },
      { command: 's', times: 6 },
      { command: 'u', times: 3 }
    ]);
    expect(macroLength(steps!)).toBe(15);
    expect(parseMacro('2ne')).toEqual([{ command: 'ne', times: 2 }]);
    expect(parseMacro('1d')).toEqual([{ command: 'd', times: 1 }]);
  });

  it('leaves one command with no directive in it to be sent as typed', () => {
    expect(parseMacro('look')).toBeNull();
    expect(parseMacro('buy 2 torch')).toBeNull();
    expect(parseMacro('say hi, all')).toBeNull();
    // A menu answer is a number and nothing else.
    expect(parseMacro('2')).toBeNull();
  });

  it('keeps a comma that is not between counted commands', () => {
    expect(parseMacro('say hi, all;n')).toEqual([
      { command: 'say hi, all', times: 1 },
      { command: 'n', times: 1 }
    ]);
    expect(parseMacro('2d,s;n')).toEqual([
      { command: '2d,s', times: 1 },
      { command: 'n', times: 1 }
    ]);
  });

  it('does not read a zero or an unsafe count as a repeat', () => {
    expect(parseMacro('0d;n')?.[0]).toEqual({ command: '0d', times: 1 });
    expect(parseMacro('99999999999999999999s;n')?.[0]).toEqual({
      command: '99999999999999999999s',
      times: 1
    });
  });

  /* Reviewer's find: `;D` split off a gossip is `D`, which walks down. */
  it('never splits a line that opens on a channel', () => {
    expect(parseMacro('gos lol ;D')).toBeNull();
    expect(parseMacro('.see you;)')).toBeNull();
    expect(parseMacro('/Soul on my way; 2 mins')).toBeNull();
    expect(parseMacro('  br back in 5;brb')).toBeNull();
    // A word that only begins like a channel is a command like any other.
    expect(parseMacro('gossipers;n')).toHaveLength(2);
  });

  it('has nothing to send for a line of separators', () => {
    expect(parseMacro(';;')).toBeNull();
  });
});
