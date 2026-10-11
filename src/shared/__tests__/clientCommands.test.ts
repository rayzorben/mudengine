import { describe, expect, it } from 'vitest';

import {
  CLIENT_COMMANDS,
  asTyped,
  caughtInTerminal,
  clientCommandOf,
  stepsOf
} from '../clientCommands';
import { fillMob, placeholdersIn, unknownPlaceholder } from '../macro';

describe('a client command', () => {
  it('is the whole line, in any case and spacing', () => {
    expect(clientCommandOf('get all')).toBe('get-all');
    expect(clientCommandOf('  GET   All ')).toBe('get-all');
    expect(clientCommandOf('equip all')).toBe('equip-all');
    expect(clientCommandOf('get all torches')).toBeNull();
    expect(clientCommandOf('get torch')).toBeNull();
  });

  it('answers to the words every member is typed as', () => {
    for (const [name, words] of Object.entries(CLIENT_COMMANDS)) {
      expect(clientCommandOf(words)).toBe(name);
    }
  });
});

describe('the steps main runs a Talk-box line as', () => {
  it('takes a line of several, a client command, or a placeholder', () => {
    expect(stepsOf('sw;equip all')).toEqual([
      { command: 'sw', times: 1 },
      { command: 'equip all', times: 1 }
    ]);
    expect(stepsOf('get all')).toEqual([{ command: 'get all', times: 1 }]);
    expect(stepsOf('a {mob}')).toEqual([{ command: 'a {mob}', times: 1 }]);
  });

  it('leaves a plain line and speech as typed', () => {
    // Positive control: the same words off a channel are a client command.
    expect(stepsOf('get all')).not.toBeNull();
    expect(stepsOf('gos get all')).toBeNull();
    expect(stepsOf('look')).toBeNull();
  });
});

describe('a placeholder', () => {
  it('is found, filled and reported when unknown', () => {
    expect(placeholdersIn('a {mob} then {who}')).toEqual(['mob', 'who']);
    expect(unknownPlaceholder('a {mob}')).toBeNull();
    expect(unknownPlaceholder('a {who}')).toBe('who');
    // A guard field is spelled as a rule spells it.
    expect(unknownPlaceholder('gos {hp} hp')).toBeNull();
    expect(fillMob('a {mob}', 'giant rat')).toBe('a giant rat');
    expect(fillMob('a {mob}', '$&')).toBe('a $&');
  });
});

describe('a line marked to go as typed', () => {
  it('goes to main with the mark, which comes off, and is never run', () => {
    expect(asTyped('\\get all')).toBe('get all');
    expect(asTyped('get all')).toBeNull();
    expect(stepsOf('\\get all')).toBeNull();
    expect(stepsOf('\\a {mob}')).toBeNull();
  });
});

describe('a line typed in the terminal', () => {
  it('is taken back when main runs it, or when its mark has to come off', () => {
    expect(caughtInTerminal('get all', {})).toBe(true);
    expect(caughtInTerminal('a {mob}', {})).toBe(true);
    expect(caughtInTerminal('\\get all', {})).toBe(true);
  });

  it('is taken back when it opens on an alias, marked or not (todo 74)', () => {
    const aliases = { kk: 'pu kobold' };
    expect(caughtInTerminal('kk', aliases)).toBe(true);
    expect(caughtInTerminal('kk thief', aliases)).toBe(true);
    expect(caughtInTerminal('\\kk', aliases)).toBe(true);
    // Positive control above: without the alias the same word goes as typed.
    expect(caughtInTerminal('kk', {})).toBe(false);
    expect(caughtInTerminal('gos kk', aliases)).toBe(false);
  });

  it('goes as typed otherwise, a ; line included', () => {
    // Positive control above: the same words alone are caught.
    expect(caughtInTerminal('gos get all', {})).toBe(false);
    expect(caughtInTerminal('sw;get all', {})).toBe(false);
    expect(caughtInTerminal('look', {})).toBe(false);
    expect(caughtInTerminal('', {})).toBe(false);
  });
});
