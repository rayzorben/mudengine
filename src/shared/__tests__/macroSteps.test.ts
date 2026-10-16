import { describe, expect, it } from 'vitest';

import { aliasCommandOf } from '../aliasCommand';
import { aliasRowRefusals, normalizeAliases } from '../aliases';
import { DEFAULT_CONFIG, normalizeConfig } from '../config';
import { keyRowRefusals, readKeys } from '../keys';
import { macroBook, loopingIn } from '../macroBook';
import { expandMacros, readMacro } from '../macroSteps';
import { pairsRecord, statedPairs } from '../pairs';

// Todo 134: a macro written one command a line, with values, calls and actions.
describe('a macro read into steps', () => {
  it('reads each kind of line', () => {
    expect(readMacro('ne\nget all\na {mob}\n{f2}\n{goto 1/297}\n{sneak}\n\\get all')).toEqual({
      steps: [
        { kind: 'send', command: 'ne', times: 1, fills: [] },
        { kind: 'client', command: 'get-all', words: 'get all' },
        { kind: 'send', command: 'a {mob}', times: 1, fills: ['mob'] },
        { kind: 'call', name: 'f2' },
        { kind: 'goto', request: '1/297' },
        { kind: 'sneak' },
        { kind: 'send', command: 'get all', times: 1, fills: [] }
      ]
    });
  });

  it('keeps a list entry whole, and still splits a ; line', () => {
    expect(readMacro('gos gg ;)\n2s')).toEqual({
      steps: [
        { kind: 'send', command: 'gos gg ;)', times: 1, fills: [] },
        { kind: 'send', command: 's', times: 2, fills: [] }
      ]
    });
    expect(readMacro('{sneak};d;bs barry;u;{goto 1/297}')).toEqual({
      steps: [
        { kind: 'sneak' },
        { kind: 'send', command: 'd', times: 1, fills: [] },
        { kind: 'send', command: 'bs barry', times: 1, fills: [] },
        { kind: 'send', command: 'u', times: 1, fills: [] },
        { kind: 'goto', request: '1/297' }
      ]
    });
  });

  it('refuses a macro or an action written inside a line', () => {
    expect(readMacro('say {goto 1/297}')).toEqual({
      fault: { kind: 'inside', name: 'goto 1/297' }
    });
    expect(readMacro('a {f2}')).toEqual({ fault: { kind: 'inside', name: 'f2' } });
    expect(readMacro('{goto}')).toEqual({ fault: { kind: 'noRoom' } });
    // Positive control: a value inside a line is a value.
    expect('steps' in readMacro('gos {hp} hp')).toBe(true);
  });

  it('runs a called macro’s lines in place', () => {
    const book = macroBook({ F2: 'n\ns' }, { doit: 'l' });
    const read = readMacro('{f2}\n{doit}');
    expect('steps' in read && expandMacros(read.steps, book, 50)).toEqual({
      steps: [
        { kind: 'send', command: 'n', times: 1, fills: [] },
        { kind: 'send', command: 's', times: 1, fills: [] },
        { kind: 'send', command: 'l', times: 1, fills: [] }
      ]
    });
  });

  it('refuses a call past the command cap whole', () => {
    const book = macroBook({ F2: '10s' }, {});
    const read = readMacro('n\n{f2}');
    expect('steps' in read && expandMacros(read.steps, book, 10)).toEqual({
      fault: { kind: 'tooMany', limit: 10 }
    });
  });

  it('stays cheap with a book where each macro calls the next twice', () => {
    // F1 calls F2 twice, F2 calls F3 twice ... F24 is 2^23 commands written out.
    const keys = Object.fromEntries(
      Array.from({ length: 24 }, (_, at) => [
        `F${at + 1}`,
        at === 23 ? 'n' : `{f${at + 2}}\n{f${at + 2}}`
      ])
    );
    const book = macroBook(keys, {});
    const started = performance.now();
    expect(loopingIn(keys, {}).size).toBe(0);
    const read = readMacro('{f1}');
    expect('steps' in read && expandMacros(read.steps, book, 50)).toEqual({
      fault: { kind: 'tooMany', limit: 50 }
    });
    expect(performance.now() - started).toBeLessThan(200);
  });

  it('runs a counted client command or action that many times', () => {
    expect(readMacro('2get all')).toEqual({
      steps: [
        { kind: 'client', command: 'get-all', words: 'get all' },
        { kind: 'client', command: 'get-all', words: 'get all' }
      ]
    });
  });

  it('finds every macro on a loop, and none on a chain beside it', () => {
    const keys = { F1: '{f2}', F2: '{f3}', F3: '{f1}', F5: '{f6}', F6: '{f7}', F7: 'n' };
    const looping = loopingIn(keys, {});
    expect([...looping].sort()).toEqual(['F1', 'F2', 'F3']);
    // Positive control: the chain loads.
    expect(readKeys(keys, looping).bindings).toEqual({ F5: '{f6}', F6: '{f7}', F7: 'n' });
    expect(keyRowRefusals(statedPairs(keys), looping)).toEqual([
      'loops',
      'loops',
      'loops',
      null,
      null,
      null
    ]);
  });

  it('finds a loop across a key and an alias, and the config loads neither', () => {
    const config = normalizeConfig({
      keys: { F1: '{doit}', F2: 'n' },
      automation: { aliases: { doit: 'l\n{f1}', ok: 'grin' } }
    });
    expect(config.keys).toEqual({ F2: 'n' });
    expect(config.automation.aliases).toEqual({ ok: 'grin' });
  });
});

describe('a macro in the file', () => {
  it('reads a list as one command a line, and writes it back as a list', () => {
    const pairs = statedPairs({ F1: ['ne', 'l', 'sw'], F2: 'rest' });
    expect(pairs).toEqual([
      { name: 'F1', text: 'ne\nl\nsw' },
      { name: 'F2', text: 'rest' }
    ]);
    expect(pairsRecord(pairs)).toEqual({ F1: ['ne', 'l', 'sw'], F2: 'rest' });
    expect(readKeys({ F1: ['ne', 'l', 'sw'] }).bindings).toEqual({ F1: 'ne\nl\nsw' });
  });

  it('refuses a value that is no line, says so, and keeps it on a save', () => {
    const pairs = statedPairs({ F1: { a: 1 }, F2: 'rest' });
    expect(keyRowRefusals(pairs)).toEqual(['shape', null]);
    expect(readKeys({ F1: { a: 1 }, F2: 'rest' })).toEqual({
      bindings: { F2: 'rest' },
      refused: [{ name: 'F1', refusal: 'shape' }]
    });
    expect(pairsRecord(pairs)).toEqual({ F1: { a: 1 }, F2: 'rest' });
    expect(aliasRowRefusals(statedPairs({ dg: [['x']], kk: 'pu kobold' }))).toEqual([
      'shape',
      null
    ]);
  });

  it('refuses an alias word the client reads itself or a key’s name', () => {
    expect(
      aliasRowRefusals(statedPairs({ alias: 'x', mob: 'x', f2: 'x', goto: 'x', dg: 'x' }))
    ).toEqual(['client', 'client', 'key', 'client', null]);
  });

  it('loads the shipped keys unchanged', () => {
    expect(readKeys(DEFAULT_CONFIG.keys).refused).toEqual([]);
    expect(normalizeAliases({ ret: '2d,6s;rest' })).toEqual({ ret: '2d,6s;rest' });
  });
});

describe('the alias command', () => {
  it('keeps what follows the word exactly, ; and braces included', () => {
    expect(aliasCommandOf('alias doit ne;recover corpse;sw')).toEqual({
      kind: 'set',
      word: 'doit',
      line: 'ne;recover corpse;sw'
    });
    expect(aliasCommandOf('alias attackhim {sneak};d;bs barry;u;{goto 1/297}')).toEqual({
      kind: 'set',
      word: 'attackhim',
      line: '{sneak};d;bs barry;u;{goto 1/297}'
    });
  });

  it('lists, shows and removes', () => {
    expect(aliasCommandOf('alias')).toEqual({ kind: 'list' });
    expect(aliasCommandOf('ALIAS DG')).toEqual({ kind: 'show', word: 'dg' });
    expect(aliasCommandOf('unalias dg')).toEqual({ kind: 'remove', word: 'dg' });
    expect(aliasCommandOf('unalias')).toEqual({ kind: 'usage' });
    // Positive control above: speech and other words are not it.
    expect(aliasCommandOf('gos alias dg')).toBeNull();
    expect(aliasCommandOf('aliases')).toBeNull();
  });
});
