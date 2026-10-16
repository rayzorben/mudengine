import { describe, expect, it } from 'vitest';

import { CLIENT_COMMANDS, asTyped, clientCommandOf } from '../clientCommands';
import { fillValue, isMacroValue, placeholdersIn } from '../macro';
import { typedSteps } from '../macroSteps';

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
    expect(typedSteps('sw;equip all')).toEqual({
      steps: [
        { kind: 'send', command: 'sw', times: 1, fills: [] },
        { kind: 'client', command: 'equip-all', words: 'equip all' }
      ]
    });
    expect(typedSteps('get all')).toEqual({
      steps: [{ kind: 'client', command: 'get-all', words: 'get all' }]
    });
    expect(typedSteps('a {mob}')).toEqual({
      steps: [{ kind: 'send', command: 'a {mob}', times: 1, fills: ['mob'] }]
    });
  });

  it('leaves a plain line and speech as typed', () => {
    // Positive control: the same words off a channel are a client command.
    expect(typedSteps('get all')).not.toBeNull();
    expect(typedSteps('gos get all')).toBeNull();
    expect(typedSteps('look')).toBeNull();
  });
});

describe('a placeholder', () => {
  it('is found, filled and reported when unknown', () => {
    expect(placeholdersIn('a {mob} then {who}')).toEqual(['mob', 'who']);
    expect(isMacroValue('mob')).toBe(true);
    expect(isMacroValue('who')).toBe(false);
    // A guard field is spelled as a rule spells it.
    expect(isMacroValue('hp')).toBe(true);
    expect(fillValue('a {mob}', 'mob', 'giant rat')).toBe('a giant rat');
    expect(fillValue('a {mob}', 'mob', '$&')).toBe('a $&');
  });
});

describe('a line marked to go as typed', () => {
  it('goes to main with the mark, which comes off, and is never run', () => {
    expect(asTyped('\\get all')).toBe('get all');
    expect(asTyped('get all')).toBeNull();
    expect(typedSteps('\\get all')).toBeNull();
    expect(typedSteps('\\a {mob}')).toBeNull();
  });
});
